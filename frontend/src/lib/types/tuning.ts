/** 各音区音分偏差明细 */
export interface TuningZones {
  /** 低音区 */
  bass: number;
  /** 中音区 */
  mid: number;
  /** 高音区 */
  treble: number;
}

/** 调律记录 */
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
  /** 当前版本号（从 1 开始；提交更正时需携带起始版本用于乐观并发控制） */
  version: number;
  /** 版本链：按前后版本保存基准音高与音区偏差，原记录不删；versions[0] 为初版，末位为当前版 */
  versions: TuningVersion[];
}

/** 调律版本快照：一次确认前后的基准音高与各音区偏差 */
export interface TuningVersion {
  /** 版本号，从 1 开始 */
  version: number;
  /** 该版本下的基准音高 Hz */
  basePitchHz: number;
  /** 平均偏差音分 */
  avgDeviationCents: number;
  /** 最大偏差音分 */
  maxDeviationCents: number;
  /** 各音区偏差明细 */
  zones: TuningZones;
  /** 是否需二次复调 */
  pitchRaised: boolean;
  /** 调律师 */
  technician: string;
  /** 调律日期 YYYY-MM-DD */
  date: string;
  /** 该版本确认时间戳（ms） */
  confirmedAt: number;
  /** 更正备注（如：更正低音区偏差） */
  note?: string;
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

export function createEmptyTuning(): Omit<Tuning, 'id' | 'version' | 'versions'> {
  return {
    pianoId: '',
    date: new Date().toISOString().slice(0, 10),
    basePitchHz: STANDARD_PITCH_HZ,
    avgDeviationCents: 0,
    maxDeviationCents: 0,
    zones: { bass: 0, mid: 0, treble: 0 },
    technician: '',
    pitchRaised: false
  };
}

/** 组装某版本的调律快照（基准音高与各音区偏差的前后对照） */
export function snapshotTuning(
  tuning: Pick<
    Tuning,
    'basePitchHz' | 'avgDeviationCents' | 'maxDeviationCents' | 'zones' | 'pitchRaised' | 'technician' | 'date'
  >,
  version: number,
  confirmedAt: number,
  note?: string
): TuningVersion {
  return {
    version,
    basePitchHz: tuning.basePitchHz,
    avgDeviationCents: tuning.avgDeviationCents,
    maxDeviationCents: tuning.maxDeviationCents,
    zones: { ...tuning.zones },
    pitchRaised: tuning.pitchRaised,
    technician: tuning.technician,
    date: tuning.date,
    confirmedAt,
    note
  };
}
