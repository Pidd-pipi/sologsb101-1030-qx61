/**
 * 调律 store：维护调律记录、基准音高与音分偏差派生值。
 * 更正按版本链保存（原记录不删），并通过版本号做乐观并发控制。
 */
import { writable, type Writable } from 'svelte/store';
import type { FilterModel } from '$lib/types/filter';
import type { Tuning } from '$lib/types/tuning';
import { snapshotTuning } from '$lib/types/tuning';
import {
  batchCorrectTuningsRows,
  correctTuningRow,
  putTuning,
  recalcReminderForPiano,
  removeTuning,
  updateTuning as updateTuningRow,
  type BatchCorrectItem,
  type BatchCorrectResult,
  type CorrectTuningResult,
  type TuningRow
} from '$lib/utils/db';
import { buildRow } from '$lib/hooks/useIdbTable';

export const TUNING_FILTER_KEYS = ['pianoIds', 'pitchRaisedOnly'];

/** 调律记录筛选条件（含「仅看需复调」开关） */
export const tuningFilters: Writable<FilterModel> = writable({
  keyword: '',
  pianoIds: [],
  switch: false
});

export function setTuningFilters(next: FilterModel): void {
  tuningFilters.set(next);
}

export function resetTuningFilters(): void {
  tuningFilters.set({ keyword: '', pianoIds: [], switch: false });
}

export async function createTuning(payload: Omit<Tuning, 'id' | 'version' | 'versions'>): Promise<string> {
  const row = buildRow(payload, 'tuning') as TuningRow;
  const now = Date.now();
  row.version = 1;
  row.versions = [snapshotTuning(row, 1, now, '初版')];
  await putTuning(row);
  // 新建调律后重算周期提醒（上次调律日期随最新调律更新）
  await recalcReminderForPiano(row.pianoId);
  return row.id;
}

export async function editTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await updateTuningRow(id, patch);
}

/**
 * 确认一条调律更正：按前后版本保存基准音高与音区偏差，原记录不删。
 * 仅当 baseVersion 与库中当前版本一致时生效；否则返回 conflict，由页面保留草稿并提示版本已变化。
 */
export async function correctTuning(
  id: string,
  baseVersion: number,
  patch: Partial<Tuning>,
  note?: string
): Promise<CorrectTuningResult> {
  return await correctTuningRow(id, baseVersion, patch, note);
}

/** 批量更正：任一引用的钢琴不存在或版本已变化则整批不写入 */
export async function batchCorrectTunings(items: BatchCorrectItem[]): Promise<BatchCorrectResult> {
  return await batchCorrectTuningsRows(items);
}

export async function deleteTuning(id: string): Promise<void> {
  await removeTuning(id);
}
