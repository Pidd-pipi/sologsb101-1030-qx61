/**
 * 调律版本链：基准音高与音区偏差的前后版本快照与更正规则。
 * - 当前生效数据保存在 tunings 表；每个历史版本在 tuningRevisions 表保存不可变快照，原记录不删。
 * - 确认更正时携带 expectedVersion 做乐观锁：两个标签页同时更正同一条时，只有先确认的版本生效。
 */
import { INITIAL_VERSION, type Tuning, type TuningZones } from './tuning';
import { needsRepitch } from '$lib/utils/cents';

/** 调律版本快照（不可变，仅追加） */
export interface TuningRevision {
  /** 主键：`${tuningId}#${version}` */
  id: string;
  /** 所属调律记录 */
  tuningId: string;
  /** 所属钢琴（冗余，便于按琴查询与级联删除） */
  pianoId: string;
  /** 版本号，初版为 1，每次更正 +1 */
  version: number;
  /** 调律日期 */
  date: string;
  /** 基准音高 Hz */
  basePitchHz: number;
  /** 平均偏差音分 */
  avgDeviationCents: number;
  /** 最大偏差音分 */
  maxDeviationCents: number;
  /** 各音区偏差明细 */
  zones: TuningZones;
  /** 调律师 */
  technician: string;
  /** 是否需二次复调 */
  pitchRaised: boolean;
  /** 本版本更正自哪个版本号（初版为 null） */
  correctedFrom: number | null;
  /** 本版本的更正说明（初版为空串） */
  correctionReason: string;
  /** 快照写入时间戳 */
  createdAt: number;
  /** 本版本生效时间戳（初版为 null，更正版本为确认更正的时间） */
  correctedAt: number | null;
}

/** 一次更正提交的内容（平均 / 最大 / 复调标记由音区偏差自动重算） */
export interface TuningCorrectionInput {
  /** 要更正的调律记录 id */
  id: string;
  /** 所属钢琴；批量更正允许指定并校验其存在，单条更正会忽略（不允许借更正换琴） */
  pianoId?: string;
  /** 调律日期 */
  date: string;
  /** 基准音高 Hz */
  basePitchHz: number;
  /** 各音区偏差明细 */
  zones: TuningZones;
  /** 调律师 */
  technician: string;
  /** 更正说明 */
  reason?: string;
  /** 打开更正页时依据的版本号；与当前版本不一致则判定版本已变化 */
  expectedVersion?: number;
}

/** 由音区偏差派生的指标 */
export interface DerivedTuningMetrics {
  avgDeviationCents: number;
  maxDeviationCents: number;
  pitchRaised: boolean;
}

/** 更正失败错误码 */
export const TUNING_CORRECTION_ERROR = {
  NOT_FOUND: 'tuning_not_found',
  VERSION_CONFLICT: 'version_conflict',
  PIANO_NOT_FOUND: 'piano_not_found',
  INVALID_INPUT: 'invalid_input'
} as const;

export type TuningCorrectionErrorCode = (typeof TUNING_CORRECTION_ERROR)[keyof typeof TUNING_CORRECTION_ERROR];

/** 更正失败（含错误码，页面据此区分版本冲突并保留草稿） */
export class TuningCorrectionError extends Error {
  code: TuningCorrectionErrorCode;
  constructor(code: TuningCorrectionErrorCode, message: string) {
    super(message);
    this.name = 'TuningCorrectionError';
    this.code = code;
  }
}

/** 单条更正预校验结果（批量更正时逐条报告） */
export interface CorrectionValidation {
  index: number;
  tuningId: string;
  ok: boolean;
  code?: TuningCorrectionErrorCode;
  message: string;
}

/** 版本快照主键 */
export function revisionId(tuningId: string, version: number): string {
  return `${tuningId}#${version}`;
}

/** 由三个音区偏差自动推导平均值、最大值与复调判定 */
export function deriveTuningMetrics(zones: TuningZones): DerivedTuningMetrics {
  const values = [zones.bass, zones.mid, zones.treble];
  const avgDeviationCents = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
  const maxDeviationCents = Number(
    values.reduce((worst, value) => (Math.abs(value) > Math.abs(worst) ? value : worst), values[0]).toFixed(1)
  );
  return {
    avgDeviationCents,
    maxDeviationCents,
    pitchRaised: needsRepitch(avgDeviationCents, maxDeviationCents)
  };
}

/** 从当前调律行构造某一版本的不可变快照 */
export function revisionFromTuning(
  tuning: Tuning,
  version: number,
  createdAt: number,
  correctedAt: number | null
): TuningRevision {
  return {
    id: revisionId(tuning.id, version),
    tuningId: tuning.id,
    pianoId: tuning.pianoId,
    version,
    date: tuning.date,
    basePitchHz: tuning.basePitchHz,
    avgDeviationCents: tuning.avgDeviationCents,
    maxDeviationCents: tuning.maxDeviationCents,
    zones: { ...tuning.zones },
    technician: tuning.technician,
    pitchRaised: tuning.pitchRaised,
    correctedFrom: version === INITIAL_VERSION ? null : version - 1,
    correctionReason: version === INITIAL_VERSION ? '' : tuning.correctionReason,
    createdAt,
    correctedAt
  };
}

/** 旧数据没有版本链时回填的初版快照 */
export function initialRevisionFromLegacy(row: {
  id: string;
  pianoId: string;
  date: string;
  basePitchHz: number;
  avgDeviationCents: number;
  maxDeviationCents: number;
  zones: TuningZones;
  technician: string;
  pitchRaised: boolean;
  createdAt?: number;
}): TuningRevision {
  const now = row.createdAt ?? Date.now();
  return {
    id: revisionId(row.id, INITIAL_VERSION),
    tuningId: row.id,
    pianoId: row.pianoId,
    version: INITIAL_VERSION,
    date: row.date,
    basePitchHz: row.basePitchHz,
    avgDeviationCents: row.avgDeviationCents,
    maxDeviationCents: row.maxDeviationCents,
    zones: { ...row.zones },
    technician: row.technician,
    pitchRaised: row.pitchRaised,
    correctedFrom: null,
    correctionReason: '',
    createdAt: now,
    correctedAt: null
  };
}

/** 给没有版本字段的旧行回填初版信息（DB 迁移与旧备份导入共用） */
export function withInitialVersion<T extends Partial<Tuning>>(
  row: T
): T & Pick<Tuning, 'version' | 'correctedFrom' | 'correctionReason' | 'correctedAt'> {
  return {
    ...row,
    version: typeof row.version === 'number' && row.version >= INITIAL_VERSION ? row.version : INITIAL_VERSION,
    correctedFrom: typeof row.correctedFrom === 'number' ? row.correctedFrom : null,
    correctionReason: typeof row.correctionReason === 'string' ? row.correctionReason : '',
    correctedAt: typeof row.correctedAt === 'number' ? row.correctedAt : null
  } as T & Pick<Tuning, 'version' | 'correctedFrom' | 'correctionReason' | 'correctedAt'>;
}

/** 校验单条更正输入的字段合法性（不查库） */
export function validateCorrectionInput(input: TuningCorrectionInput, index: number): CorrectionValidation {
  const base: CorrectionValidation = { index, tuningId: input?.id ?? '', ok: false, message: '' };
  if (!input || typeof input.id !== 'string' || !input.id.trim()) {
    return { ...base, code: TUNING_CORRECTION_ERROR.INVALID_INPUT, message: '缺少调律记录 id' };
  }
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ...base, code: TUNING_CORRECTION_ERROR.INVALID_INPUT, message: `第 ${index + 1} 条日期格式应为 YYYY-MM-DD` };
  }
  if (typeof input.basePitchHz !== 'number' || input.basePitchHz < 400 || input.basePitchHz > 480) {
    return { ...base, code: TUNING_CORRECTION_ERROR.INVALID_INPUT, message: `第 ${index + 1} 条基准音高应在 400–480 Hz 之间` };
  }
  const zones = input.zones;
  if (
    !zones ||
    typeof zones.bass !== 'number' ||
    typeof zones.mid !== 'number' ||
    typeof zones.treble !== 'number' ||
    [zones.bass, zones.mid, zones.treble].some((value) => !Number.isFinite(value))
  ) {
    return { ...base, code: TUNING_CORRECTION_ERROR.INVALID_INPUT, message: `第 ${index + 1} 条音区偏差必须为数字（bass / mid / treble）` };
  }
  if (typeof input.technician !== 'string' || !input.technician.trim()) {
    return { ...base, code: TUNING_CORRECTION_ERROR.INVALID_INPUT, message: `第 ${index + 1} 条缺少调律师` };
  }
  return { ...base, ok: true, message: 'ok' };
}

/** 批量更正弹窗的输入模板 */
export const BATCH_CORRECTION_TEMPLATE = JSON.stringify(
  [
    {
      id: 'tn-001',
      date: '2024-04-08',
      basePitchHz: 440,
      zones: { bass: -10.0, mid: -4.5, treble: -2.0 },
      technician: '陆师傅',
      reason: '复测后修正低音区偏差'
    }
  ],
  null,
  2
);

/** 解析批量更正 JSON（数组或 { corrections: [...] }） */
export function parseCorrections(text: string): TuningCorrectionInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { corrections?: unknown[] } | null)?.corrections)
      ? (parsed as { corrections: unknown[] }).corrections
      : null;
  if (!list) throw new Error('根节点应为更正数组，或 { "corrections": [...] }');
  if (list.length === 0) throw new Error('没有需要更正的条目');
  return list as TuningCorrectionInput[];
}
