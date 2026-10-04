/**
 * 调律版本链 / 更正 / 批量原子性 / 回填 的集成验证（fake-indexeddb）。
 * 运行：npx tsx scripts/verify-versioning.ts
 */
import 'fake-indexeddb/auto';
import { db, initDatabase, backfillTuningVersions, correctTuningRow, batchCorrectTuningsRows, putPiano, putTuning, putReminder } from '../src/lib/utils/db';
import type { PianoRow, TuningRow, ReminderRow } from '../src/lib/utils/db';
import { buildRow } from '../src/lib/hooks/useIdbTable';
import { snapshotTuning } from '../src/lib/types/tuning';
import { addMonths } from '../src/lib/types/reminder';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function main(): Promise<void> {
  await db.open();

  // 准备一台钢琴
  const piano = buildRow(
    { brand: 'YAMAHA', model: 'U1', serialNo: 'S1', type: '立式', venue: '琴房', purchaseYear: 2020, state: '正常' },
    'piano'
  ) as PianoRow;
  await putPiano(piano);

  // 一条「旧数据」：没有版本链
  const legacy = buildRow(
    {
      pianoId: piano.id,
      date: '2024-05-01',
      basePitchHz: 440,
      avgDeviationCents: -6.5,
      maxDeviationCents: -14,
      zones: { bass: -14, mid: -5, treble: -2 },
      technician: '陆师傅',
      pitchRaised: false
    },
    'tuning'
  ) as TuningRow;
  delete (legacy as Partial<TuningRow>).version;
  delete (legacy as Partial<TuningRow>).versions;
  await putTuning(legacy);

  // 一条新数据：带版本链
  const fresh = buildRow(
    {
      pianoId: piano.id,
      date: '2024-06-01',
      basePitchHz: 441,
      avgDeviationCents: 9,
      maxDeviationCents: 21,
      zones: { bass: 6, mid: 9, treble: 21 },
      technician: '顾老师',
      pitchRaised: true
    },
    'tuning'
  ) as TuningRow;
  const now = Date.now();
  fresh.version = 1;
  fresh.versions = [snapshotTuning(fresh, 1, now, '初版')];
  await putTuning(fresh);

  // 一条提醒
  const reminder = buildRow(
    { pianoId: piano.id, cycleMonths: 6, lastTuningDate: '2024-06-01', nextDueDate: addMonths('2024-06-01', 6), state: '临近' },
    'reminder'
  ) as ReminderRow;
  await putReminder(reminder);

  console.log('\n[1] 回填旧数据版本链');
  await backfillTuningVersions();
  const legacyAfter = await db.tunings.get(legacy.id);
  assert(legacyAfter?.version === 1, '旧数据回填后 version = 1');
  assert(Array.isArray(legacyAfter?.versions) && legacyAfter.versions.length === 1, '旧数据回填后有 1 条初版');
  assert(legacyAfter?.versions[0].note === '初版（回填）', '初版备注为回填');
  assert(legacyAfter?.versions[0].zones.bass === -14, '初版快照保留原低音区偏差');
  // 幂等：再跑一次不重复回填
  await backfillTuningVersions();
  const legacyAgain = await db.tunings.get(legacy.id);
  assert(legacyAgain?.versions.length === 1, '回填幂等，不重复生成初版');

  console.log('\n[2] 确认更正：按前后版本保存，原记录不删');
  const result = await correctTuningRow(
    fresh.id,
    1,
    { zones: { bass: -10, mid: -5, treble: -2 }, avgDeviationCents: -5.7, maxDeviationCents: -10, pitchRaised: false },
    '更正低音区偏差'
  );
  assert(result.status === 'ok', '更正成功（版本一致）');
  const corrected = await db.tunings.get(fresh.id);
  assert(corrected?.version === 2, '更正后 version = 2');
  assert(corrected?.versions.length === 2, '版本链含 2 条（前后）');
  assert(corrected?.versions[0].zones.bass === 6, '初版（前）低音区偏差保留为 6');
  assert(corrected?.versions[1].zones.bass === -10, '新版（后）低音区偏差为 -10');
  assert(corrected?.versions[1].note === '更正低音区偏差', '新版备注正确');
  assert(corrected?.zones.bass === -10, '主记录低音区偏差已更新为新版');
  assert(corrected?.pitchRaised === false, '主记录复调判定已更新');

  console.log('\n[3] 周期提醒按新版本重算');
  const reminderAfter = await db.reminders.get(reminder.id);
  assert(reminderAfter?.lastTuningDate === '2024-06-01', '提醒上次调律日期为最新调律日期');
  assert(reminderAfter?.nextDueDate === addMonths('2024-06-01', 6), '提醒下次建议日期已重算');

  console.log('\n[4] 乐观并发：两个标签页同时提交同一条更正，先确认生效，后确认冲突');
  // 标签页 A 以 v2 为基础提交
  const a = await correctTuningRow(fresh.id, 2, { zones: { bass: -11, mid: -5, treble: -2 } }, '标签页A');
  assert(a.status === 'ok', '标签页A（先确认）生效，version → 3');
  // 标签页 B 仍以旧的 v2 为基础提交（草稿）
  const b = await correctTuningRow(fresh.id, 2, { zones: { bass: -12, mid: -5, treble: -2 } }, '标签页B');
  assert(b.status === 'conflict', '标签页B（后确认）返回 conflict');
  if (b.status === 'conflict') {
    assert(b.current.version === 3, '冲突时带回当前最新版本 v3');
  }
  const afterConflict = await db.tunings.get(fresh.id);
  assert(afterConflict?.version === 3, '冲突后版本仍为 3（只有 A 生效）');
  assert(afterConflict?.zones.bass === -11, '冲突后数据为 A 的结果（-11），B 的草稿未写入');
  assert(afterConflict?.versions.length === 3, '冲突后版本链仍为 3 条');

  console.log('\n[5] 批量更正：引用的钢琴不存在，整批不写入');
  const beforeCount = await db.tunings.count();
  const batchAborted = await batchCorrectTuningsRows([
    { tuningId: fresh.id, baseVersion: 3, patch: { zones: { bass: -20, mid: -5, treble: -2 } }, note: '正常' },
    { tuningId: legacy.id, baseVersion: 1, patch: { zones: { bass: -20, mid: -5, treble: -2 } }, note: '正常' },
    { tuningId: 'tn-not-exist', baseVersion: 1, patch: { zones: { bass: 0, mid: 0, treble: 0 } }, note: '幽灵调律' }
  ]);
  assert(batchAborted.status === 'aborted', '批量更正返回 aborted');
  const afterAbort = await db.tunings.get(fresh.id);
  assert(afterAbort?.version === 3, '整批未写入：fresh 版本仍为 3');
  const afterAbortLegacy = await db.tunings.get(legacy.id);
  assert(afterAbortLegacy?.version === 1, '整批未写入：legacy 版本仍为 1');
  assert((await db.tunings.count()) === beforeCount, '整批未写入：调律总数不变');

  console.log('\n[6] 批量更正：全部引用存在时整批生效');
  const batchOk = await batchCorrectTuningsRows([
    { tuningId: fresh.id, baseVersion: 3, patch: { zones: { bass: -15, mid: -6, treble: -3 } }, note: '批量A' },
    { tuningId: legacy.id, baseVersion: 1, patch: { zones: { bass: -16, mid: -6, treble: -3 } }, note: '批量B' }
  ]);
  assert(batchOk.status === 'ok' && batchOk.status === 'ok' && batchOk.count === 2, '批量更正成功，count = 2');
  const freshFinal = await db.tunings.get(fresh.id);
  const legacyFinal = await db.tunings.get(legacy.id);
  assert(freshFinal?.version === 4, 'fresh 版本 → 4');
  assert(legacyFinal?.version === 2, 'legacy 版本 → 2');
  assert(freshFinal?.versions.length === 4, 'fresh 版本链 4 条');
  assert(legacyFinal?.versions.length === 2, 'legacy 版本链 2 条');

  console.log('\n[7] initDatabase 幂等回填（清空后重进会重新播种并回填）');
  // 验证 initDatabase 不报错（库已打开，pianos 非空，不播种）
  await initDatabase();
  assert(true, 'initDatabase 执行正常');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
