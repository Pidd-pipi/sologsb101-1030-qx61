/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbpianotune-db，结构版本 v2：tunings 增加版本链字段，新增 tuningRevisions 版本快照表
 * - 钢琴 / 调律 / 调律版本快照 / 整音维修 / 琴房环境 / 周期提醒 分表存储
 * - 首次打开自动播种互相引用的演示数据（含超期琴与异常环境），保证每个页面打开都有内容
 */
import Dexie, { type Table } from 'dexie';
import type { Piano } from '$lib/types/piano';
import type { Tuning } from '$lib/types/tuning';
import type { Voicing } from '$lib/types/voicing';
import type { Environment } from '$lib/types/environment';
import type { Reminder } from '$lib/types/reminder';
import {
  deriveTuningMetrics,
  initialRevisionFromLegacy,
  revisionFromTuning,
  validateCorrectionInput,
  withInitialVersion,
  TUNING_CORRECTION_ERROR,
  TuningCorrectionError,
  type CorrectionValidation,
  type TuningCorrectionInput,
  type TuningRevision
} from '$lib/types/tuningVersion';
import { deriveReminderState } from '$lib/types/reminder';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbpianotune-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号 */
export const ROW_REVISION = 1;

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type PianoRow = Piano & Revisioned;
export type TuningRow = Tuning & Revisioned;
export type TuningRevisionRow = TuningRevision;
export type VoicingRow = Voicing & Revisioned;
export type EnvironmentRow = Environment & Revisioned;
export type ReminderRow = Reminder & Revisioned;

class GbPianoTuneDatabase extends Dexie {
  pianos!: Table<PianoRow, string>;
  tunings!: Table<TuningRow, string>;
  tuningRevisions!: Table<TuningRevisionRow, string>;
  voicings!: Table<VoicingRow, string>;
  environments!: Table<EnvironmentRow, string>;
  reminders!: Table<ReminderRow, string>;

  constructor() {
    super(DB_NAME);

    // v2：调律记录支持版本链（version / correctedFrom / correctionReason / correctedAt），
    // 新增 tuningRevisions 表按 `调律id#版本号` 保存不可变前后版本快照。
    this.version(1).stores({
      pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
      tunings: 'id, pianoId, date, technician, pitchRaised, updatedAt',
      voicings: 'id, pianoId, type, parts, state, date, updatedAt',
      environments: 'id, pianoId, date, device, abnormal, updatedAt',
      reminders: 'id, pianoId, state, nextDueDate, updatedAt'
    });

    this.version(2)
      .stores({
        pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
        tunings: 'id, pianoId, date, technician, pitchRaised, version, updatedAt',
        tuningRevisions: 'id, tuningId, pianoId, version, createdAt',
        voicings: 'id, pianoId, type, parts, state, date, updatedAt',
        environments: 'id, pianoId, date, device, abnormal, updatedAt',
        reminders: 'id, pianoId, state, nextDueDate, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['pianos', 'tunings', 'voicings', 'environments', 'reminders'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }
        // 旧数据没有版本链：回填调律行的初版字段，并在 tuningRevisions 补初版快照（原记录不删）
        await tx
          .table<TuningRow>('tunings')
          .toCollection()
          .modify((row: TuningRow) => {
            const stamped = withInitialVersion(row);
            row.version = stamped.version;
            row.correctedFrom = stamped.correctedFrom;
            row.correctionReason = stamped.correctionReason;
            row.correctedAt = stamped.correctedAt;
          });
        const legacyRows = await tx.table<TuningRow>('tunings').toArray();
        if (legacyRows.length > 0) {
          await tx
            .table<TuningRevisionRow>('tuningRevisions')
            .bulkPut(legacyRows.map((row) => initialRevisionFromLegacy(row)));
        }
      });
  }
}

export const db = new GbPianoTuneDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.pianos.count()) === 0) {
    await seedDatabase();
  }
  // 兼容：旧版代码可能已建过 v2 结构但漏了初版快照
  await backfillInitialRevisions();
}

/** 为缺少版本链 / 初版快照的调律记录回填（旧备份导入后同样调用） */
export async function backfillInitialRevisions(): Promise<void> {
  await db.transaction('rw', [db.tunings, db.tuningRevisions], async () => {
    const tunings = await db.tunings.toArray();
    for (const row of tunings) {
      const stamped = withInitialVersion(row);
      const needPatch =
        row.version !== stamped.version ||
        row.correctedFrom !== stamped.correctedFrom ||
        row.correctionReason !== stamped.correctionReason ||
        row.correctedAt !== stamped.correctedAt;
      if (needPatch) {
        await db.tunings.update(row.id, {
          version: stamped.version,
          correctedFrom: stamped.correctedFrom,
          correctionReason: stamped.correctionReason,
          correctedAt: stamped.correctedAt
        });
      }
      const exists = await db.tuningRevisions.get(`${row.id}#${stamped.version}`);
      if (!exists) {
        await db.tuningRevisions.put(
          initialRevisionFromLegacy({ ...row, ...stamped })
        );
      }
    }
  });
}

/* ------------------------------ 钢琴 ------------------------------ */

export async function listPianos(): Promise<PianoRow[]> {
  const rows = await db.pianos.toArray();
  return rows.sort((a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN') || a.model.localeCompare(b.model, 'zh-Hans-CN'));
}

export async function putPiano(row: PianoRow): Promise<void> {
  await db.pianos.put(row);
}

export async function updatePiano(id: string, patch: Partial<Piano>): Promise<void> {
  await db.pianos.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除钢琴：级联删除其调律 / 版本快照 / 维修 / 环境 / 提醒 */
export async function removePiano(id: string): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.tuningRevisions, db.voicings, db.environments, db.reminders], async () => {
    await db.tunings.where('pianoId').equals(id).delete();
    await db.tuningRevisions.where('pianoId').equals(id).delete();
    await db.voicings.where('pianoId').equals(id).delete();
    await db.environments.where('pianoId').equals(id).delete();
    await db.reminders.where('pianoId').equals(id).delete();
    await db.pianos.delete(id);
  });
}

/* ------------------------------ 调律 ------------------------------ */

export async function listTunings(): Promise<TuningRow[]> {
  const rows = await db.tunings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putTuning(row: TuningRow): Promise<void> {
  // 新增调律：同时写入初版快照
  await db.transaction('rw', [db.tunings, db.tuningRevisions], async () => {
    await db.tunings.put(row);
    const existing = await db.tuningRevisions.get(`${row.id}#${row.version}`);
    if (!existing) {
      await db.tuningRevisions.put(
        revisionFromTuning(row, row.version, row.createdAt, null)
      );
    }
  });
}

export async function updateTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await db.tunings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeTuning(id: string): Promise<void> {
  // 删除调律：其版本快照一并清理
  await db.transaction('rw', [db.tunings, db.tuningRevisions], async () => {
    await db.tuningRevisions.where('tuningId').equals(id).delete();
    await db.tunings.delete(id);
  });
}

/** 列出某条调律的全部历史版本（版本号升序） */
export async function listTuningRevisions(tuningId: string): Promise<TuningRevisionRow[]> {
  const rows = await db.tuningRevisions.where('tuningId').equals(tuningId).toArray();
  return rows.sort((a, b) => a.version - b.version);
}

/** 某台琴名下全部版本快照（版本履历面板用） */
export async function listRevisionsByPiano(pianoId: string): Promise<TuningRevisionRow[]> {
  const rows = await db.tuningRevisions.where('pianoId').equals(pianoId).toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version);
}

/* ----------------------- 调律更正（版本链） ----------------------- */

/** 更正后按新版本重算该琴周期提醒：同步上次调律日期、下次建议日期与状态 */
async function recalcReminderForTuning(pianoId: string): Promise<void> {
  // 处于调用方的 rw 事务中：Dexie 会把这些操作自动并入当前事务
  const ordered = await db.tunings.where('pianoId').equals(pianoId).sortBy('date');
  const newest = ordered[ordered.length - 1] as TuningRow | undefined;
  const lastTuningDate = newest?.date ?? '';
  const reminders = await db.reminders.where('pianoId').equals(pianoId).toArray();
  for (const reminder of reminders as ReminderRow[]) {
    const nextDueDate = addMonthsLocal(lastTuningDate, reminder.cycleMonths);
    await db.reminders.update(reminder.id, {
      lastTuningDate,
      nextDueDate,
      state: deriveReminderState(nextDueDate),
      updatedAt: Date.now()
    });
  }
}

/** 周期推算（与 reminder 类型同规则，事务内直接复用避免循环依赖） */
function addMonthsLocal(date: string, months: number): string {
  if (!date) return '';
  const base = new Date(`${date}T00:00:00`);
  if (Number.isNaN(base.getTime())) return '';
  base.setMonth(base.getMonth() + months);
  return base.toISOString().slice(0, 10);
}

/**
 * 确认更正一条调律记录：
 * 1. 旧版本写入不可变快照（原记录不删）；
 * 2. tunings 当前行覆盖为新版本（version + 1）；
 * 3. 同事务按新版本重算该琴周期提醒。
 * 携带 expectedVersion 时做乐观锁：与当前版本不一致抛 VERSION_CONFLICT（页面保留草稿）。
 */
export async function confirmTuningCorrection(input: TuningCorrectionInput): Promise<number> {
  const validation = validateCorrectionInput(input, 0);
  if (!validation.ok) {
    throw new TuningCorrectionError(validation.code ?? TUNING_CORRECTION_ERROR.INVALID_INPUT, validation.message);
  }
  return db.transaction('rw', [db.tunings, db.tuningRevisions, db.reminders, db.pianos], async () => {
    const current = await db.tunings.get(input.id);
    if (!current) {
      throw new TuningCorrectionError(TUNING_CORRECTION_ERROR.NOT_FOUND, '调律记录不存在或已被删除');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new TuningCorrectionError(
        TUNING_CORRECTION_ERROR.VERSION_CONFLICT,
        `该调律记录已被其他页面更新到 v${current.version}，您打开时是 v${input.expectedVersion}`
      );
    }
    const piano = await db.pianos.get(current.pianoId);
    if (!piano) {
      throw new TuningCorrectionError(TUNING_CORRECTION_ERROR.PIANO_NOT_FOUND, '引用的钢琴档案不存在');
    }

    const now = Date.now();
    const metrics = deriveTuningMetrics(input.zones);
    const nextVersion = current.version + 1;

    // 旧版本快照（若历史链路缺失先补齐，原记录不删）
    const previousSnapshotId = `${current.id}#${current.version}`;
    const previousSnapshot = await db.tuningRevisions.get(previousSnapshotId);
    if (!previousSnapshot) {
      await db.tuningRevisions.put(revisionFromTuning(current, current.version, current.createdAt, current.correctedAt));
    }

    const nextRow: TuningRow = {
      ...current,
      date: input.date,
      basePitchHz: input.basePitchHz,
      zones: { ...input.zones },
      technician: input.technician.trim(),
      avgDeviationCents: metrics.avgDeviationCents,
      maxDeviationCents: metrics.maxDeviationCents,
      pitchRaised: metrics.pitchRaised,
      version: nextVersion,
      correctedFrom: current.version,
      correctionReason: (input.reason ?? '').trim(),
      correctedAt: now,
      updatedAt: now
    };
    await db.tunings.put(nextRow);
    await db.tuningRevisions.put(revisionFromTuning(nextRow, nextVersion, now, now));

    await recalcReminderForTuning(current.pianoId);
    return nextVersion;
  });
}

/**
 * 批量确认更正：单事务预校验，引用的钢琴不存在 / 记录不存在 / 字段非法时本次整批不写入。
 * 每条携带 expectedVersion 时同样做乐观锁校验。
 * @returns 每条更正后的新版本号（与输入同序）
 */
export async function confirmTuningCorrections(inputs: TuningCorrectionInput[]): Promise<{ versions: number[]; results: CorrectionValidation[] }> {
  const results: CorrectionValidation[] = inputs.map((input, index) => validateCorrectionInput(input, index));
  if (results.some((item) => !item.ok)) {
    throw new TuningCorrectionError(TUNING_CORRECTION_ERROR.INVALID_INPUT, '存在字段非法的更正条目，本次未写入任何记录');
  }
  return db.transaction('rw', [db.tunings, db.tuningRevisions, db.reminders, db.pianos], async () => {
    // 预校验：记录是否存在、版本是否变化、引用钢琴是否存在——任一不过整批回滚
    const currentRows: TuningRow[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const current = await db.tunings.get(input.id);
      if (!current) {
        throw new TuningCorrectionError(
          TUNING_CORRECTION_ERROR.NOT_FOUND,
          `第 ${index + 1} 条调律记录不存在（id=${input.id}），本次未写入任何记录`
        );
      }
      const piano = await db.pianos.get(input.pianoId ?? current.pianoId);
      if (!piano) {
        throw new TuningCorrectionError(
          TUNING_CORRECTION_ERROR.PIANO_NOT_FOUND,
          `第 ${index + 1} 条引用的钢琴不存在，本次未写入任何记录`
        );
      }
      if (input.pianoId && input.pianoId !== current.pianoId) {
        throw new TuningCorrectionError(
          TUNING_CORRECTION_ERROR.INVALID_INPUT,
          `第 ${index + 1} 条指定的钢琴与调律记录归属不一致，本次未写入任何记录`
        );
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw new TuningCorrectionError(
          TUNING_CORRECTION_ERROR.VERSION_CONFLICT,
          `第 ${index + 1} 条版本已变化（当前 v${current.version}，草稿基于 v${input.expectedVersion}），本次未写入任何记录`
        );
      }
      currentRows.push(current);
    }

    const now = Date.now();
    const versions: number[] = [];
    const affectedPianos = new Set<string>();
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const current = currentRows[index];
      const metrics = deriveTuningMetrics(input.zones);
      const nextVersion = current.version + 1;
      const previousSnapshot = await db.tuningRevisions.get(`${current.id}#${current.version}`);
      if (!previousSnapshot) {
        await db.tuningRevisions.put(revisionFromTuning(current, current.version, current.createdAt, current.correctedAt));
      }
      const nextRow: TuningRow = {
        ...current,
        date: input.date,
        basePitchHz: input.basePitchHz,
        zones: { ...input.zones },
        technician: input.technician.trim(),
        avgDeviationCents: metrics.avgDeviationCents,
        maxDeviationCents: metrics.maxDeviationCents,
        pitchRaised: metrics.pitchRaised,
        version: nextVersion,
        correctedFrom: current.version,
        correctionReason: (input.reason ?? '').trim(),
        correctedAt: now,
        updatedAt: now
      };
      await db.tunings.put(nextRow);
      await db.tuningRevisions.put(revisionFromTuning(nextRow, nextVersion, now, now));
      affectedPianos.add(current.pianoId);
      versions.push(nextVersion);
    }
    for (const pianoId of affectedPianos) {
      await recalcReminderForTuning(pianoId);
    }
    return {
      versions,
      results: results.map((item) => ({ ...item, ok: true, message: 'ok' }))
    };
  });
}

/* --------------------------- 整音与维修 --------------------------- */

export async function listVoicings(): Promise<VoicingRow[]> {
  const rows = await db.voicings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putVoicing(row: VoicingRow): Promise<void> {
  await db.voicings.put(row);
}

export async function updateVoicing(id: string, patch: Partial<Voicing>): Promise<void> {
  await db.voicings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 完成维修：回写钢琴状态（全部完成则置为正常，否则置为待修） */
export async function completeVoicing(id: string): Promise<void> {
  await db.transaction('rw', [db.voicings, db.pianos], async () => {
    const voicing = await db.voicings.get(id);
    if (!voicing) throw new Error('维修记录不存在');
    await db.voicings.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.voicings
      .where('pianoId')
      .equals(voicing.pianoId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.pianos.update(voicing.pianoId, {
      state: pending === 0 ? '正常' : '待修',
      updatedAt: Date.now()
    } as never);
  });
}

/** 新建维修计划时把钢琴置为待修 */
export async function markPianoPending(pianoId: string): Promise<void> {
  await db.pianos.update(pianoId, { state: '待修', updatedAt: Date.now() } as never);
}

export async function removeVoicing(id: string): Promise<void> {
  await db.voicings.delete(id);
}

/* ---------------------------- 琴房环境 ---------------------------- */

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  const rows = await db.environments.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putEnvironment(row: EnvironmentRow): Promise<void> {
  await db.environments.put(row);
}

export async function updateEnvironment(id: string, patch: Partial<Environment>): Promise<void> {
  await db.environments.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeEnvironment(id: string): Promise<void> {
  await db.environments.delete(id);
}

/* ---------------------------- 周期提醒 ---------------------------- */

export async function listReminders(): Promise<ReminderRow[]> {
  const rows = await db.reminders.toArray();
  return rows.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}

export async function putReminder(row: ReminderRow): Promise<void> {
  await db.reminders.put(row);
}

export async function updateReminder(id: string, patch: Partial<Reminder>): Promise<void> {
  await db.reminders.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeReminder(id: string): Promise<void> {
  await db.reminders.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  pianos: Piano[];
  tunings: Tuning[];
  voicings: Voicing[];
  environments: Environment[];
  reminders: Reminder[];
  /** v2 起导出调律前后版本快照；旧备份无此字段 */
  tuningRevisions?: TuningRevision[];
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [pianos, tunings, tuningRevisions, voicings, environments, reminders] = await Promise.all([
    db.pianos.toArray(),
    db.tunings.toArray(),
    db.tuningRevisions.toArray(),
    db.voicings.toArray(),
    db.environments.toArray(),
    db.reminders.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    pianos: pianos.map(stripRow),
    tunings: tunings.map(stripRow),
    voicings: voicings.map(stripRow),
    environments: environments.map(stripRow),
    reminders: reminders.map(stripRow),
    tuningRevisions: tuningRevisions.map((row) => ({ ...row }))
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.tuningRevisions, db.voicings, db.environments, db.reminders], async () => {
    await Promise.all([
      db.pianos.clear(),
      db.tunings.clear(),
      db.tuningRevisions.clear(),
      db.voicings.clear(),
      db.environments.clear(),
      db.reminders.clear()
    ]);
    // 旧备份的调律没有版本链：统一回填初版字段
    const tunings = (snapshot.tunings ?? []).map((row) => withInitialVersion(stamp(row)));
    await db.pianos.bulkPut((snapshot.pianos ?? []).map(stamp));
    await db.tunings.bulkPut(tunings);
    // 快照优先用备份自带的；缺失（旧备份）则按当前行回填初版
    const revisions =
      snapshot.tuningRevisions && snapshot.tuningRevisions.length > 0
        ? snapshot.tuningRevisions
        : tunings.map((row) => initialRevisionFromLegacy(row));
    await db.tuningRevisions.bulkPut(revisions);
    await db.voicings.bulkPut((snapshot.voicings ?? []).map(stamp));
    await db.environments.bulkPut((snapshot.environments ?? []).map(stamp));
    await db.reminders.bulkPut((snapshot.reminders ?? []).map(stamp));
  });
  // 双保险：任何缺链 / 缺快照的行都补齐
  await backfillInitialRevisions();
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.tuningRevisions, db.voicings, db.environments, db.reminders], async () => {
    await Promise.all([
      db.pianos.clear(),
      db.tunings.clear(),
      db.tuningRevisions.clear(),
      db.voicings.clear(),
      db.environments.clear(),
      db.reminders.clear()
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [pianos, tunings, tuningRevisions, voicings, environments, reminders] = await Promise.all([
    db.pianos.count(),
    db.tunings.count(),
    db.tuningRevisions.count(),
    db.voicings.count(),
    db.environments.count(),
    db.reminders.count()
  ]);
  return { pianos, tunings, tuningRevisions, voicings, environments, reminders };
}
