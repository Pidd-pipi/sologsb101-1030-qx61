/**
 * 版本链逻辑运行时验证（fake-indexeddb + esbuild 临时执行，不入构建）。
 * 覆盖：v1→v2 旧数据回填、确认更正、双标签页乐观锁、批量更正原子性、
 * 旧备份导入回填、更正联动重算提醒、删除级联。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let passed = 0;
let failed = 0;
function assert(cond: boolean, message: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

/* ---------- 1. 旧数据（v1，无版本链）升级到 v2 并回填初版 ---------- */
async function scenarioLegacyUpgrade(): Promise<void> {
  console.log('1) v1 旧库升级：回填版本链初版');

  // 以 v1 结构建库并写入一条没有版本字段的旧调律
  const legacy = new Dexie('gbpianotune-db');
  legacy.version(1).stores({
    pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
    tunings: 'id, pianoId, date, technician, pitchRaised, updatedAt',
    voicings: 'id, pianoId, type, parts, state, date, updatedAt',
    environments: 'id, pianoId, date, device, abnormal, updatedAt',
    reminders: 'id, pianoId, state, nextDueDate, updatedAt'
  });
  await legacy.open();
  const now = Date.now();
  await (legacy as any).pianos.bulkPut([
    { id: 'p1', brand: 'YAMAHA', model: 'U1', serialNo: '', type: '立式', venue: '琴房', purchaseYear: 2015, state: '正常', revision: 1, createdAt: now, updatedAt: now }
  ]);
  await (legacy as any).tunings.bulkPut([
    {
      id: 't1', pianoId: 'p1', date: '2024-04-08', basePitchHz: 440,
      avgDeviationCents: -6.5, maxDeviationCents: -14.2,
      zones: { bass: -14.2, mid: -5.1, treble: -2.8 },
      technician: '陆师傅', pitchRaised: false
    }
  ]);
  await (legacy as any).reminders.bulkPut([
    { id: 'r1', pianoId: 'p1', cycleMonths: 6, lastTuningDate: '2024-04-08', nextDueDate: '2024-10-08', state: '正常', revision: 1, createdAt: now, updatedAt: now }
  ]);
  await legacy.close();

  // 用当前代码（v2）重新打开并回填
  const { db, initDatabase, listTuningRevisions } = await import('../src/lib/utils/db');
  await initDatabase();

  const t1 = await db.tunings.get('t1');
  assert(t1?.version === 1, '旧调律行回填 version=1');
  assert(t1?.correctedFrom === null && t1?.correctedAt === null, '旧调律行回填 correctedFrom/correctedAt');
  const revisions = await listTuningRevisions('t1');
  assert(revisions.length === 1 && revisions[0].version === 1, 'tuningRevisions 回填 1 条初版快照');
  assert(revisions[0].zones.bass === -14.2, '初版快照保留旧低音区偏差');
}

/* ---------- 2. 确认更正：原记录不删、新版本生效、提醒联动 ---------- */
async function scenarioCorrection(): Promise<void> {
  console.log('2) 确认更正：版本链追加 + 琴档摘要依据 + 周期提醒重算');
  const { db, confirmTuningCorrection, listTuningRevisions } = await import('../src/lib/utils/db');

  const next = await confirmTuningCorrection({
    id: 't1',
    date: '2024-04-08',
    basePitchHz: 440.2,
    zones: { bass: -6.0, mid: -4.5, treble: -2.0 },
    technician: '陆师傅',
    reason: '复测后修正低音区偏差',
    expectedVersion: 1
  });
  assert(next === 2, '确认更正后返回新版本号 v2');

  const t1 = await db.tunings.get('t1');
  assert(t1?.version === 2, '当前行更新为 v2');
  assert(t1?.zones.bass === -6.0, '当前行使用新低音区偏差');
  assert(t1?.basePitchHz === 440.2, '当前行使用新基准音高');
  assert(t1?.correctedFrom === 1 && t1?.correctionReason === '复测后修正低音区偏差', '记录更正来源与说明');
  assert(Math.abs((t1?.avgDeviationCents ?? 0) - (-4.2)) < 0.01, '平均偏差按新版本重算 (-4.2)');

  const revisions = await listTuningRevisions('t1');
  assert(revisions.length === 2, '版本履历保留 2 个版本（原记录不删）');
  assert(revisions[0].version === 1 && revisions[0].zones.bass === -14.2, 'v1 旧低音区偏差仍在履历中');
  assert(revisions[1].version === 2 && revisions[1].zones.bass === -6, 'v2 新低音区偏差写入履历');

  const reminder = await db.reminders.get('r1');
  assert(reminder?.lastTuningDate === '2024-04-08', '周期提醒的上次调律日期与新版本一致');
  assert(reminder?.nextDueDate === '2024-10-08', '周期提醒按新版本重算下次建议日期');

  // 再更正一次，顺便改日期，验证提醒日期联动
  await confirmTuningCorrection({
    id: 't1', date: '2024-05-10', basePitchHz: 440,
    zones: { bass: -3, mid: -2, treble: -1 }, technician: '陆师傅',
    reason: '二次复测', expectedVersion: 2
  });
  const reminder2 = await db.reminders.get('r1');
  assert(reminder2?.lastTuningDate === '2024-05-10' && reminder2?.nextDueDate === '2024-11-10', '更正改期后提醒跟随重算到 2024-11-10');
  const revisions3 = await listTuningRevisions('t1');
  assert(revisions3.length === 3, '第三次版本履历共 3 条');
}

/* ---------- 3. 两个标签页同时确认：乐观锁，后到者失败 ---------- */
async function scenarioConflict(): Promise<void> {
  console.log('3) 双标签页并发更正：先确认者生效，后确认者版本冲突且不写入');
  const { db, confirmTuningCorrection, listTuningRevisions } = await import('../src/lib/utils/db');
  const { TuningCorrectionError, TUNING_CORRECTION_ERROR } = await import('../src/lib/types/tuningVersion');

  // 两个页面都基于 v3 打开
  const corrections: Promise<unknown>[] = [
    confirmTuningCorrection({
      id: 't1', date: '2024-05-10', basePitchHz: 440,
      zones: { bass: -9, mid: -2, treble: -1 }, technician: '陆师傅',
      reason: '标签页A', expectedVersion: 3
    }),
    confirmTuningCorrection({
      id: 't1', date: '2024-05-10', basePitchHz: 439,
      zones: { bass: 9, mid: 2, treble: 1 }, technician: '顾老师',
      reason: '标签页B', expectedVersion: 3
    })
  ];
  const results = await Promise.allSettled(corrections);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert(fulfilled.length === 1 && rejected.length === 1, '只有一个确认生效');
  const error = (rejected[0] as PromiseRejectedResult).reason;
  assert(error instanceof TuningCorrectionError, '后确认方抛出 TuningCorrectionError');
  assert(error.code === TUNING_CORRECTION_ERROR.VERSION_CONFLICT, '错误码为 version_conflict');

  const t1 = await db.tunings.get('t1');
  assert(t1?.version === 4, '最终版本为 v4（未产生 v5）');
  const revisions = await listTuningRevisions('t1');
  assert(revisions.length === 4, '履历仍为 4 条（冲突方未写入）');
  const winnerReason = (fulfilled[0] as PromiseFulfilledResult<number>).value === 4;
  assert(winnerReason && (t1?.correctionReason === '标签页A' || t1?.correctionReason === '标签页B'), '保留的是先确认方的更正内容');

  // 后确认方基于新版本重试 → 成功
  const retry = await confirmTuningCorrection({
    id: 't1', date: '2024-05-10', basePitchHz: 439,
    zones: { bass: 8, mid: 2, treble: 1 }, technician: '顾老师',
    reason: '标签页B重试', expectedVersion: 4
  });
  assert(retry === 5 && (await db.tunings.get('t1'))?.version === 5, '基于新版本重新确认后生效 v5');
}

/* ---------- 4. 批量更正原子性：引用钢琴不存在整批不写 ---------- */
async function scenarioBatch(): Promise<void> {
  console.log('4) 批量更正：预校验失败整批回滚');
  const { db, confirmTuningCorrections, listTuningRevisions } = await import('../src/lib/utils/db');
  const { TuningCorrectionError, TUNING_CORRECTION_ERROR } = await import('../src/lib/types/tuningVersion');

  // 再加一条调律 t2
  await db.pianos.bulkPut([
    { id: 'p2', brand: 'KAWAI', model: 'K3', serialNo: '', type: '立式', venue: '家庭', purchaseYear: 2010, state: '正常', revision: 1, createdAt: Date.now(), updatedAt: Date.now() } as any
  ]);
  await db.tunings.put({
    id: 't2', pianoId: 'p2', date: '2024-02-01', basePitchHz: 440,
    avgDeviationCents: 0, maxDeviationCents: 0, zones: { bass: 0, mid: 0, treble: 0 },
    technician: '顾老师', pitchRaised: false, version: 1, correctedFrom: null, correctionReason: '', correctedAt: null,
    revision: 1, createdAt: Date.now(), updatedAt: Date.now()
  });
  await db.tuningRevisions.put({
    id: 't2#1', tuningId: 't2', pianoId: 'p2', version: 1, date: '2024-02-01', basePitchHz: 440,
    avgDeviationCents: 0, maxDeviationCents: 0, zones: { bass: 0, mid: 0, treble: 0 },
    technician: '顾老师', pitchRaised: false, correctedFrom: null, correctionReason: '', createdAt: Date.now(), correctedAt: null
  });

  // 4a. 引用的钢琴不存在（t2 显式指定不存在的 pianoId）
  let caught: any = null;
  try {
    await confirmTuningCorrections([
      { id: 't1', date: '2024-05-10', basePitchHz: 440, zones: { bass: 1, mid: 1, treble: 1 }, technician: '陆师傅', reason: '批量A' },
      { id: 't2', pianoId: 'p-ghost', date: '2024-02-01', basePitchHz: 440, zones: { bass: 2, mid: 2, treble: 2 }, technician: '顾老师', reason: '批量B-幽灵钢琴' }
    ]);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof TuningCorrectionError && caught.code === TUNING_CORRECTION_ERROR.PIANO_NOT_FOUND, '引用钢琴不存在报 piano_not_found');
  assert((await db.tunings.get('t1'))?.version === 5, '整批回滚：t1 仍为 v5');
  assert((await db.tunings.get('t2'))?.version === 1, '整批回滚：t2 仍为 v1');
  assert((await listTuningRevisions('t2')).length === 1, 't2 履历未追加');

  // 4b. 调律记录不存在
  caught = null;
  try {
    await confirmTuningCorrections([
      { id: 't-ghost', date: '2024-02-01', basePitchHz: 440, zones: { bass: 1, mid: 1, treble: 1 }, technician: '陆师傅' }
    ]);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof TuningCorrectionError && caught.code === TUNING_CORRECTION_ERROR.NOT_FOUND, '调律不存在报 tuning_not_found，整批不写');

  // 4c. 字段非法（缺调律师）
  caught = null;
  try {
    await confirmTuningCorrections([
      { id: 't1', date: '2024-05-10', basePitchHz: 440, zones: { bass: 1, mid: 1, treble: 1 }, technician: '' }
    ]);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof TuningCorrectionError && caught.code === TUNING_CORRECTION_ERROR.INVALID_INPUT, '字段非法报 invalid_input，整批不写');

  // 4d. 指定的钢琴与记录归属不一致 → 整批不写
  caught = null;
  try {
    await confirmTuningCorrections([
      { id: 't1', pianoId: 'p2', date: '2024-05-10', basePitchHz: 440, zones: { bass: 1, mid: 1, treble: 1 }, technician: '陆师傅' }
    ]);
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof TuningCorrectionError && caught.code === TUNING_CORRECTION_ERROR.INVALID_INPUT, '钢琴归属不一致报 invalid_input，整批不写');

  // 4e. 合法批量 → 全部生效
  const { versions } = await confirmTuningCorrections([
    { id: 't1', date: '2024-05-10', basePitchHz: 440, zones: { bass: 1.5, mid: 1, treble: 1 }, technician: '陆师傅', reason: '批量A', expectedVersion: 5 },
    { id: 't2', date: '2024-02-01', basePitchHz: 440.5, zones: { bass: -3, mid: -1, treble: 2 }, technician: '顾老师', reason: '批量B' }
  ]);
  assert(JSON.stringify(versions) === JSON.stringify([6, 2]), '合法批量返回新版本号 [6, 2]');
  assert((await db.tunings.get('t1'))?.zones.bass === 1.5 && (await db.tunings.get('t2'))?.basePitchHz === 440.5, '两条批量更正均生效');
}

/* ---------- 5. 旧备份导入：无版本链时回填初版 ---------- */
async function scenarioImportLegacy(): Promise<void> {
  console.log('5) 导入旧结构备份：回填初版版本链');
  const { db, importSnapshot, listTuningRevisions } = await import('../src/lib/utils/db');

  await importSnapshot({
    name: 'gbpianotune-db',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    pianos: [
      { id: 'px', brand: '珠江', model: 'UP118', serialNo: '', type: '立式', venue: '家庭', purchaseYear: 2012, state: '正常' } as any
    ],
    tunings: [
      {
        id: 'tx', pianoId: 'px', date: '2023-11-02', basePitchHz: 437.2,
        avgDeviationCents: -22.5, maxDeviationCents: -35,
        zones: { bass: -35, mid: -21.4, treble: -12.6 },
        technician: '陆师傅', pitchRaised: true
      } as any
    ],
    voicings: [],
    environments: [],
    reminders: []
  });
  const tx = await db.tunings.get('tx');
  assert(tx?.version === 1, '导入旧调律回填 version=1');
  const revisions = await listTuningRevisions('tx');
  assert(revisions.length === 1 && revisions[0].zones.bass === -35, '导入后自动补初版快照（旧数据无版本链）');
}

/* ---------- 6. 删除钢琴级联清理版本快照 ---------- */
async function scenarioCascade(): Promise<void> {
  console.log('6) 删除钢琴：级联清理调律与版本快照');
  const { db, removePiano } = await import('../src/lib/utils/db');
  await removePiano('px');
  const tunes = await db.tunings.where('pianoId').equals('px').count();
  const revs = await db.tuningRevisions.where('pianoId').equals('px').count();
  assert(tunes === 0 && revs === 0, '调律与其版本快照一并删除');
}

async function main(): Promise<void> {
  try {
    await scenarioLegacyUpgrade();
    await scenarioCorrection();
    await scenarioConflict();
    await scenarioBatch();
    await scenarioImportLegacy();
    await scenarioCascade();
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    if (failed > 0) process.exit(1);
  } catch (error) {
    console.error('测试执行异常', error);
    process.exit(1);
  }
}

void main();
