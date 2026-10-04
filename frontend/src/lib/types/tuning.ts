/** 各音区音分偏差明细 */
export interface TuningZones {
  /** 低音区 */
  bass: number;
  /** 中音区 */
  mid: number;
  /** 高音区 */
  treble: number;
}

/** 调律记录（当前生效版本；历史版本保存在 tuningRevisions 表） */
export interface Tuning {
  id: string;
  /** 所属钢琴 */
  pianoId: string;
  /** 调律日期 YYYY-MM-DD */
  date: string;
  /** 基准音高 Hz（标准 A4 = 440 Hz） */
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
  /** 当前版本号，初版为 1；每次更正 +1 */
  version: number;
  /** 本版本更正自哪个版本号（初版为 null） */
  correctedFrom: number | null;
  /** 最近一次更正说明（初版为空串） */
  correctionReason: string;
  /** 最近一次更正时间戳（初版为 null） */
  correctedAt: number | null;
}

/** 表单草稿：基准音高与音区偏差（平均 / 最大 / 复调由音区自动派生） */
export interface TuningDraft {
  pianoId: string;
  date: string;
  basePitchHz: number;
  zones: TuningZones;
  technician: string;
}

/** 标准基准音高 */
export const STANDARD_PITCH_HZ = 440;
/** 平均偏差超过该值即建议复调（音分） */
export const REPITCH_AVG_THRESHOLD = 8;
/** 最大偏差超过该值即建议复调（音分） */
export const REPITCH_MAX_THRESHOLD = 20;

export const ZONE_LABELS: Array<{ key: keyof TuningZones; label: string }> = [
  { key: 'bass', label: '低音区' },
  { key: 'mid', label: '中音区' },
  { key: 'treble', label: '高音区' }
];

/** 初版版本号 */
export const INITIAL_VERSION = 1;

/** 取一组调律中最近一次（日期降序，同日取更新时间更晚的） */
export function pickLatestTuning<T extends { date: string; updatedAt?: number }>(rows: T[]): T | undefined {
  return [...rows].sort(
    (a, b) => b.date.localeCompare(a.date) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  )[0];
}

export function createEmptyTuning(): Omit<Tuning, 'id'> {
  return {
    pianoId: '',
    date: new Date().toISOString().slice(0, 10),
    basePitchHz: STANDARD_PITCH_HZ,
    avgDeviationCents: 0,
    maxDeviationCents: 0,
    zones: { bass: 0, mid: 0, treble: 0 },
    technician: '',
    pitchRaised: false,
    version: INITIAL_VERSION,
    correctedFrom: null,
    correctionReason: '',
    correctedAt: null
  };
}

/** 新增调律时的空表单草稿 */
export function createEmptyTuningDraft(): TuningDraft {
  return {
    pianoId: '',
    date: new Date().toISOString().slice(0, 10),
    basePitchHz: STANDARD_PITCH_HZ,
    zones: { bass: 0, mid: 0, treble: 0 },
    technician: ''
  };
}
