/**
 * 调律 store：维护调律记录、基准音高与音分偏差派生值，以及调律更正版本链动作。
 * - 确认更正：append 新版本快照（原记录不删）并联动重算周期提醒
 * - 乐观锁：携带 expectedVersion；两个标签页同时更正同一条时只有先确认的版本生效，
 *   后确认的页面收到版本冲突、保留草稿并提示版本已变化
 * - 批量更正：引用钢琴不存在等预校验失败时整批不写入
 */
import { writable, type Writable } from 'svelte/store';
import type { FilterModel } from '$lib/types/filter';
import type { Tuning, TuningDraft } from '$lib/types/tuning';
import {
  TuningCorrectionError,
  TUNING_CORRECTION_ERROR,
  type TuningCorrectionInput
} from '$lib/types/tuningVersion';
import {
  confirmTuningCorrection,
  confirmTuningCorrections,
  putTuning,
  updateTuning as updateTuningRow,
  removeTuning
} from '$lib/utils/db';
import { buildRow } from '$lib/hooks/useIdbTable';

export { TuningCorrectionError, TUNING_CORRECTION_ERROR };
export type { TuningCorrectionInput };

export const TUNING_FILTER_KEYS = ['pianoIds', 'pitchRaisedOnly'];

/** 调律记录筛选条件（含「仅看需复调」开关） */
export const tuningFilters: Writable<FilterModel> = writable({
  keyword: '',
  pianoIds: [],
  switch: false
});

/** 更正冲突提示（跨标签页场景）：tuningId → 当前版本号 */
export interface CorrectionConflict {
  tuningId: string;
  /** 草稿依据的版本 */
  expectedVersion: number;
  /** 库中当前版本（另一个标签页先确认后的版本） */
  currentVersion: number;
  message: string;
}

export const correctionConflict = writable<CorrectionConflict | null>(null);

export function clearCorrectionConflict(): void {
  correctionConflict.set(null);
}

export function setTuningFilters(next: FilterModel): void {
  tuningFilters.set(next);
}

export function resetTuningFilters(): void {
  tuningFilters.set({ keyword: '', pianoIds: [], switch: false });
}

export async function createTuning(payload: Omit<Tuning, 'id'>): Promise<string> {
  const row = buildRow(payload, 'tuning');
  await putTuning(row);
  return row.id;
}

export async function editTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await updateTuningRow(id, patch);
}

export async function deleteTuning(id: string): Promise<void> {
  await removeTuning(id);
  clearDraft(id);
}

/* ---------------------------- 更正版本链 ---------------------------- */

/**
 * 确认更正一条调律记录。
 * 成功后调用方应关闭表单并清掉草稿；版本冲突时抛出 TuningCorrectionError，
 * 调用方保留草稿、提示「版本已变化」，不要关闭弹窗。
 */
export async function correctTuning(input: TuningCorrectionInput): Promise<number> {
  try {
    const nextVersion = await confirmTuningCorrection(input);
    clearDraft(input.id);
    clearCorrectionConflict();
    return nextVersion;
  } catch (error) {
    if (error instanceof TuningCorrectionError && error.code === TUNING_CORRECTION_ERROR.VERSION_CONFLICT) {
      // 保留草稿：写入 localStorage，刷新页面后仍可继续
      persistDraftOnConflict(input);
    }
    throw error;
  }
}

/**
 * 批量确认更正：任一记录引用的钢琴不存在 / 记录缺失 / 版本冲突，本次整批不写入。
 */
export async function batchCorrectTunings(
  inputs: TuningCorrectionInput[]
): Promise<{ versions: number[] }> {
  const result = await confirmTuningCorrections(inputs);
  return { versions: result.versions };
}

/* --------------------------- 更正草稿暂存 --------------------------- */

const DRAFT_PREFIX = 'gbpianotune:tuning-draft:';

interface StoredDraft {
  draft: TuningDraft;
  reason: string;
  expectedVersion: number;
  savedAt: number;
}

function draftKey(tuningId: string): string {
  return `${DRAFT_PREFIX}${tuningId}`;
}

/** 暂存更正草稿（版本冲突后页面保留草稿用） */
export function saveDraft(
  tuningId: string,
  draft: TuningDraft,
  expectedVersion: number,
  reason = ''
): void {
  try {
    const stored: StoredDraft = { draft, reason, expectedVersion, savedAt: Date.now() };
    localStorage.setItem(draftKey(tuningId), JSON.stringify(stored));
  } catch {
    // 隐私模式等场景下 localStorage 不可用：草稿仍保留在当前页面内存中
  }
}

function persistDraftOnConflict(input: TuningCorrectionInput): void {
  const draft: TuningDraft = {
    pianoId: input.pianoId ?? '',
    date: input.date,
    basePitchHz: input.basePitchHz,
    zones: { ...input.zones },
    technician: input.technician
  };
  saveDraft(input.id, draft, input.expectedVersion ?? 1, input.reason ?? '');
  correctionConflict.set({
    tuningId: input.id,
    expectedVersion: input.expectedVersion ?? 1,
    currentVersion: (input.expectedVersion ?? 1) + 1,
    message: '版本已变化：另一个页面已先确认该更正，您的草稿已保留，请核对当前版本后再提交。'
  });
}

/** 读取暂存草稿（无则返回 null） */
export function loadDraft(tuningId: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(tuningId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (!parsed || typeof parsed.draft !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(tuningId: string): void {
  try {
    localStorage.removeItem(draftKey(tuningId));
  } catch {
    // ignore
  }
}
