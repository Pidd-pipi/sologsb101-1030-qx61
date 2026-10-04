<script lang="ts">
  /** /tunings 调律记录：录入基准音高与各音区音分偏差；更正走版本链（原记录不删），支持版本履历与批量更正 */
  import { onMount } from 'svelte';
  import { push, router } from '$lib/router';
  import FilterBar from '$lib/components/common/FilterBar.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import CentsTag from '$lib/components/common/CentsTag.svelte';
  import VersionTag from '$lib/components/common/VersionTag.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { summarizeCents } from '$lib/hooks/useCentsDeviation';
  import {
    db,
    listTuningRevisions,
    type PianoRow,
    type TuningRow,
    type TuningRevisionRow
  } from '$lib/utils/db';
  import {
    createEmptyTuning,
    REPITCH_AVG_THRESHOLD,
    REPITCH_MAX_THRESHOLD,
    STANDARD_PITCH_HZ,
    ZONE_LABELS,
    INITIAL_VERSION,
    type Tuning,
    type TuningDraft
  } from '$lib/types/tuning';
  import {
    BATCH_CORRECTION_TEMPLATE,
    parseCorrections,
    TuningCorrectionError,
    TUNING_CORRECTION_ERROR,
    type TuningCorrectionInput
  } from '$lib/types/tuningVersion';
  import {
    batchCorrectTunings,
    clearDraft,
    correctTuning,
    createTuning,
    deleteTuning,
    loadDraft,
    resetTuningFilters,
    saveDraft,
    setTuningFilters,
    TUNING_FILTER_KEYS,
    tuningFilters
  } from '$lib/stores/tuningStore';
  import { bandColor, barHeight, centsFromStandardPitch, formatCents } from '$lib/utils/cents';
  import type { FilterModel, FilterSelectConfig } from '$lib/types/filter';
  import { queryToFilters, toQueryString } from '$lib/utils/query';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const tunings = useIdbTable<TuningRow>(db.tunings, (a, b) => b.date.localeCompare(a.date));

  /** 弹窗模式：create 新增 / correct 更正（新版本） */
  type DialogMode = 'create' | 'correct';
  let dialogOpen = $state(false);
  let dialogMode = $state<DialogMode>('create');
  let editingId = $state<string | null>(null);
  /** 更正时页面依据的版本号（乐观锁） */
  let expectedVersion = $state(INITIAL_VERSION);
  /** 从暂存草稿恢复时标记 */
  let draftRestored = $state(false);
  let form = $state<Omit<Tuning, 'id'>>(createEmptyTuning());
  let formError = $state<string | null>(null);
  /** 版本冲突横幅：另一个标签页已先确认，草稿保留 */
  let versionConflict = $state<string | null>(null);
  /** 弹窗开着期间，其他标签页已先确认了新版本（liveQuery 实时感知） */
  let externalVersionChanged = $state(false);
  let correctionReason = $state('');

  /** 版本履历 */
  let historyOpen = $state(false);
  let historyTuning = $state<TuningRow | null>(null);
  let historyRows = $state<TuningRevisionRow[]>([]);
  let historyLoading = $state(false);

  /** 批量更正 */
  let batchOpen = $state(false);
  let batchText = $state('');
  let batchError = $state<string | null>(null);
  let batchSuccess = $state<string | null>(null);
  let batchBusy = $state(false);

  const selects = $derived<FilterSelectConfig[]>([
    {
      key: 'pianoIds',
      label: '钢琴',
      options: $pianos.map((item) => ({ label: `${item.brand} ${item.model}`, value: item.id }))
    }
  ]);

  function asArray(value: string | string[] | boolean | undefined): string[] {
    return Array.isArray(value) ? value : [];
  }

  function pianoLabel(pianoId: string): string {
    const piano = $pianos.find((item) => item.id === pianoId);
    return piano ? `${piano.brand} ${piano.model}` : '钢琴已删除';
  }

  const filtered = $derived(
    $tunings.filter((tuning) => {
      const keyword = String($tuningFilters.keyword ?? '').trim().toLowerCase();
      const pianoIds = asArray($tuningFilters.pianoIds);
      const label = `${pianoLabel(tuning.pianoId)} ${tuning.technician} ${tuning.date}`.toLowerCase();
      if (keyword && !label.includes(keyword)) return false;
      if (pianoIds.length > 0 && !pianoIds.includes(tuning.pianoId)) return false;
      if ($tuningFilters.switch && !tuning.pitchRaised) return false;
      return true;
    })
  );

  /** 各音区偏差条形图数据（取列表中出现过的音区最大值作为参考） */
  const zoneRows = $derived(
    ZONE_LABELS.map((zone) => {
      const value = filtered.length > 0 ? filtered[0].zones[zone.key] : 0;
      return { ...zone, value };
    })
  );

  const totals = $derived.by(() => {
    const all = $tunings;
    const repitch = all.filter((item) => item.pitchRaised).length;
    const avg = all.length > 0 ? all.reduce((sum, item) => sum + item.avgDeviationCents, 0) / all.length : 0;
    const maxAbs = all.reduce((max, item) => Math.max(max, Math.abs(item.maxDeviationCents)), 0);
    return {
      tuningCount: all.length,
      repitchCount: repitch,
      repitchRatio: all.length > 0 ? Math.round((repitch / all.length) * 100) : 0,
      avgDeviation: Number(avg.toFixed(1)),
      maxDeviation: Number(maxAbs.toFixed(1)),
      pianoCovered: new Set(all.map((item) => item.pianoId)).size,
      correctedCount: all.filter((item) => item.version > 1).length
    };
  });

  /** 由三个音区偏差自动推导平均值与最大值 */
  function recalc(): void {
    const values = [form.zones.bass, form.zones.mid, form.zones.treble];
    form.avgDeviationCents = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
    form.maxDeviationCents = Number(
      values.reduce((worst, value) => (Math.abs(value) > Math.abs(worst) ? value : worst), values[0]).toFixed(1)
    );
    const absAvg = Math.abs(form.avgDeviationCents);
    const absMax = Math.abs(form.maxDeviationCents);
    form.pitchRaised = absAvg > REPITCH_AVG_THRESHOLD || absMax > REPITCH_MAX_THRESHOLD;
  }

  /** 打开更正弹窗时记录的版本号（用于识别弹窗打开期间其他标签页的确认） */
  let observedVersionAtOpen = 0;

  // 更正弹窗打开期间，另一标签页先确认 → liveQuery 推送新版本，实时提示版本已变化
  $effect(() => {
    if (!dialogOpen || dialogMode !== 'correct' || !editingId) return;
    const current = $tunings.find((item) => item.id === editingId);
    if (current && current.version !== observedVersionAtOpen) {
      externalVersionChanged = true;
    }
  });

  function openCreate(): void {
    dialogMode = 'create';
    editingId = null;
    form = createEmptyTuning();
    if ($pianos.length > 0) form.pianoId = $pianos[0].id;
    correctionReason = '';
    formError = null;
    versionConflict = null;
    externalVersionChanged = false;
    draftRestored = false;
    observedVersionAtOpen = 0;
    dialogOpen = true;
  }

  /**
   * 打开更正弹窗：表单预填当前版本数据；
   * 若该记录存在被保留的草稿（上次确认时版本冲突），优先恢复草稿并提示。
   */
  function openCorrect(tuning: TuningRow): void {
    dialogMode = 'correct';
    editingId = tuning.id;
    observedVersionAtOpen = tuning.version;
    externalVersionChanged = false;
    const stored = loadDraft(tuning.id);
    const draft: TuningDraft = stored
      ? stored.draft
      : {
          pianoId: tuning.pianoId,
          date: tuning.date,
          basePitchHz: tuning.basePitchHz,
          zones: { ...tuning.zones },
          technician: tuning.technician
        };
    form = {
      ...createEmptyTuning(),
      ...draft,
      zones: { ...draft.zones },
      version: tuning.version,
      correctedFrom: tuning.correctedFrom,
      correctionReason: tuning.correctionReason,
      correctedAt: tuning.correctedAt
    };
    correctionReason = stored?.reason ?? '';
    expectedVersion = stored?.expectedVersion ?? tuning.version;
    draftRestored = Boolean(stored);
    versionConflict =
      stored && stored.expectedVersion !== tuning.version
        ? `版本已变化：该记录当前为 v${tuning.version}，草稿基于 v${stored.expectedVersion}，请核对后再确认更正。`
        : null;
    formError = null;
    recalc();
    dialogOpen = true;
  }

  function discardDraft(): void {
    if (!editingId) return;
    clearDraft(editingId);
    const current = $tunings.find((item) => item.id === editingId);
    if (current) openCorrect(current);
  }

  /** 其他标签页先确认后：保留当前表单草稿，仅把基准版本切到最新版本再提交 */
  function adoptNewVersion(): void {
    const current = editingId ? $tunings.find((item) => item.id === editingId) : undefined;
    if (!current) return;
    expectedVersion = current.version;
    observedVersionAtOpen = current.version;
    externalVersionChanged = false;
    versionConflict = null;
    formError = null;
  }

  /** 确认更正（新版本）；版本冲突时弹窗保留、草稿保留并提示 */
  async function submit(): Promise<void> {
    if (!form.pianoId) {
      formError = '请选择钢琴';
      return;
    }
    if (!form.technician.trim()) {
      formError = '请填写调律师';
      return;
    }
    if (form.basePitchHz < 400 || form.basePitchHz > 480) {
      formError = '基准音高应在 400–480 Hz 之间';
      return;
    }
    if (dialogMode === 'correct' && !correctionReason.trim()) {
      formError = '请填写更正说明（如：复测后修正低音区偏差）';
      return;
    }
    recalc();

    if (dialogMode === 'create' || !editingId) {
      await createTuning({ ...form, zones: { ...form.zones } });
      dialogOpen = false;
      return;
    }

    const input: TuningCorrectionInput = {
      id: editingId,
      date: form.date,
      basePitchHz: form.basePitchHz,
      zones: { ...form.zones },
      technician: form.technician,
      reason: correctionReason,
      expectedVersion
    };
    try {
      await correctTuning(input);
      dialogOpen = false;
    } catch (error) {
      if (error instanceof TuningCorrectionError && error.code === TUNING_CORRECTION_ERROR.VERSION_CONFLICT) {
        // 版本已变化：保留草稿（store 已持久化），同步当前版本号，提示后可基于新版本再确认
        const current = $tunings.find((item) => item.id === editingId);
        const currentVersion = current?.version ?? expectedVersion + 1;
        versionConflict = `${error.message}；草稿已保留，核对后可再次确认。`;
        expectedVersion = currentVersion;
        observedVersionAtOpen = currentVersion;
        externalVersionChanged = false;
        formError = null;
      } else {
        formError = error instanceof Error ? error.message : '更正失败';
      }
    }
  }

  /** 关闭弹窗时把未提交的更正草稿暂存，便于切换页面 / 刷新后继续 */
  function closeDialog(): void {
    if (dialogMode === 'correct' && editingId && !formError) {
      saveDraft(editingId, {
        pianoId: form.pianoId,
        date: form.date,
        basePitchHz: form.basePitchHz,
        zones: { ...form.zones },
        technician: form.technician
      }, expectedVersion, correctionReason);
    }
    dialogOpen = false;
  }

  async function openHistory(tuning: TuningRow): Promise<void> {
    historyTuning = tuning;
    historyOpen = true;
    historyLoading = true;
    historyRows = await listTuningRevisions(tuning.id);
    historyLoading = false;
  }

  function formatTimestamp(value: number | null): string {
    if (!value) return '—';
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  }

  async function remove(tuning: TuningRow): Promise<void> {
    if (!window.confirm(`删除 ${tuning.date} 的调律记录？其全部历史版本快照将一并删除。`)) return;
    await deleteTuning(tuning.id);
  }

  async function submitBatch(): Promise<void> {
    batchError = null;
    batchSuccess = null;
    batchBusy = true;
    try {
      const inputs = parseCorrections(batchText);
      const { versions } = await batchCorrectTunings(inputs);
      batchSuccess = `本次共确认 ${inputs.length} 条更正，新版本号：${versions.map((v) => `v${v}`).join('、')}`;
      batchText = '';
    } catch (error) {
      batchError = error instanceof Error ? error.message : '批量更正失败，本次未写入任何记录';
    } finally {
      batchBusy = false;
    }
  }

  function openBatch(): void {
    batchOpen = true;
    batchText = BATCH_CORRECTION_TEMPLATE;
    batchError = null;
    batchSuccess = null;
  }

  function applyFilters(next: FilterModel): void {
    setTuningFilters(next);
    void push(`/tunings${toQueryString(next)}`);
  }

  onMount(() => {
    const query: Record<string, string> = {};
    new URLSearchParams(router.querystring ?? '').forEach((value, key) => {
      query[key] = value;
    });
    setTuningFilters(queryToFilters(query, TUNING_FILTER_KEYS));
  });

  /** 当前选中钢琴的音分小结，用于弹窗里的实时提示 */
  const dialogSummary = $derived(form.pianoId ? summarizeCents($tunings, form.pianoId) : null);
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">调律记录</h2>
      <p class="page-subtitle">
        标准音 A4 = {STANDARD_PITCH_HZ} Hz；平均偏差超过 {REPITCH_AVG_THRESHOLD} 音分或最大偏差超过 {REPITCH_MAX_THRESHOLD} 音分自动标记需复调。
        更正会保留前后版本并联动重算琴档摘要与周期提醒。
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="btn" onclick={openBatch} disabled={$pianos.length === 0}>批量更正</button>
      <button type="button" class="btn-primary" onclick={openCreate} disabled={$pianos.length === 0}>+ 新增调律记录</button>
    </div>
  </div>

  <div class="badge-row">
    <StatBadge label="调律次数" value={totals.tuningCount} suffix="次" tone="walnut" icon="🎼" />
    <StatBadge label="需复调" value={totals.repitchCount} suffix="次" tone="rose" icon="!" />
    <StatBadge label="复调占比" value={totals.repitchRatio} percent={totals.repitchRatio} showPercent tone="amber" icon="%" />
    <StatBadge label="平均偏差" value={totals.avgDeviation} suffix="音分" tone="brass" icon="≈" />
    <StatBadge label="最大偏差" value={totals.maxDeviation} suffix="音分" tone="slate" icon="‼" />
    <StatBadge label="已更正记录" value={totals.correctedCount} suffix="条" tone="green" icon="v" />
  </div>

  <FilterBar
    filters={$tuningFilters}
    {selects}
    keywordPlaceholder="搜索钢琴 / 调律师 / 日期…"
    switchLabel="仅看需复调"
    onchange={applyFilters}
    onreset={() => {
      resetTuningFilters();
      void push('/tunings');
    }}
  />

  {#if filtered.length === 0}
    <EmptyPanel
      title="暂无调律记录"
      description="选择一台钢琴，录入基准音高与低/中/高音区的音分偏差。"
      showCreate={$pianos.length > 0}
      createText="新增调律记录"
      oncreate={openCreate}
    />
  {:else}
    <div class="card">
      <div class="card-title mb-3">
        <span>音区偏差条形图（{pianoLabel(filtered[0].pianoId)} · {filtered[0].date}）</span>
        <span class="muted">以 ±40 音分为满格 · 当前 v{filtered[0].version}</span>
      </div>
      <div class="flex items-end gap-6">
        {#each zoneRows as zone (zone.key)}
          <div class="flex w-28 flex-col items-center gap-1">
            <span class="text-xs tabular-nums text-stone-500">{formatCents(zone.value)}</span>
            <div class="flex h-32 w-full items-end rounded-lg bg-stone-100">
              <div
                class="w-full rounded-t-lg transition-all"
                style="height: {barHeight(zone.value)}%; background-color: {bandColor(zone.value)}"
              ></div>
            </div>
            <span class="text-xs text-stone-500">{zone.label}</span>
          </div>
        {/each}
      </div>
    </div>

    <div class="card overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
          <tr>
            <th class="py-2">钢琴</th>
            <th class="py-2">日期</th>
            <th class="py-2">基准音高</th>
            <th class="py-2">平均偏差</th>
            <th class="py-2">最大偏差</th>
            <th class="py-2">低 / 中 / 高音区</th>
            <th class="py-2">调律师</th>
            <th class="py-2">复调</th>
            <th class="py-2">版本</th>
            <th class="py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as tuning (tuning.id)}
            <tr class="border-b border-stone-100">
              <td class="py-2">{pianoLabel(tuning.pianoId)}</td>
              <td class="py-2">{tuning.date}</td>
              <td class="py-2 tabular-nums">
                {tuning.basePitchHz} Hz
                <div class="muted">{formatCents(centsFromStandardPitch(tuning.basePitchHz))}</div>
              </td>
              <td class="py-2"><CentsTag cents={tuning.avgDeviationCents} size="sm" /></td>
              <td class="py-2"><CentsTag cents={tuning.maxDeviationCents} size="sm" /></td>
              <td class="py-2 tabular-nums text-xs text-stone-500">
                {tuning.zones.bass} / {tuning.zones.mid} / {tuning.zones.treble}
              </td>
              <td class="py-2">{tuning.technician}</td>
              <td class="py-2">
                {#if tuning.pitchRaised}
                  <span class="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">需复调</span>
                {:else}
                  <span class="muted">正常</span>
                {/if}
              </td>
              <td class="py-2">
                <VersionTag version={tuning.version} />
                {#if tuning.correctionReason}
                  <div class="muted mt-0.5 max-w-[160px] truncate" title={tuning.correctionReason}>{tuning.correctionReason}</div>
                {/if}
              </td>
              <td class="py-2 whitespace-nowrap">
                <button type="button" class="btn mr-2" onclick={() => openCorrect(tuning)}>更正</button>
                <button type="button" class="btn mr-2" onclick={() => openHistory(tuning)}>履历</button>
                <button type="button" class="btn-danger" onclick={() => remove(tuning)}>删除</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if dialogOpen}
  <div class="modal-mask">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      aria-label="关闭弹窗"
      onclick={closeDialog}
    ></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-1 text-base font-semibold">
        {dialogMode === 'correct' && editingId ? `确认更正 · 生成 v${expectedVersion + 1}` : '新增调律记录'}
      </h3>
      {#if dialogMode === 'correct'}
        <p class="muted mb-3">
          当前 v{expectedVersion} 的基准音高与音区偏差会原样保留在版本履历中，确认后琴档摘要、维修履历依据与周期提醒按新版本重算。
        </p>
      {/if}

      {#if draftRestored}
        <div class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          已恢复上次未提交的更正草稿（基于 v{expectedVersion}）。
          <button type="button" class="ml-2 underline" onclick={discardDraft}>放弃草稿，用当前数据重填</button>
        </div>
      {/if}
      {#if externalVersionChanged}
        {@const currentTuning = $tunings.find((item) => item.id === editingId)}
        <div class="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
          <div class="font-semibold">版本已变化</div>
          <div class="mt-0.5">
            另一个页面已先确认该更正，当前为 v{currentTuning?.version ?? '?'}；您的草稿仍保留，核对后可基于新版本确认。
          </div>
          <div class="mt-1.5 flex gap-2">
            <button type="button" class="rounded bg-indigo-600 px-2 py-0.5 text-white" onclick={adoptNewVersion}>
              保留草稿并基于 v{currentTuning?.version ?? ''} 继续
            </button>
            <button type="button" class="underline" onclick={discardDraft}>放弃草稿，载入当前版本数据</button>
          </div>
        </div>
      {/if}
      {#if versionConflict}
        <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <div class="font-semibold">版本已变化</div>
          <div class="mt-0.5">{versionConflict}</div>
        </div>
      {/if}
      {#if formError}
        <div class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError}</div>
      {/if}

      <div class="grid gap-3 md:grid-cols-2">
        <div>
          <span class="label">钢琴</span>
          <select class="field" bind:value={form.pianoId} onchange={recalc} disabled={dialogMode === 'correct'}>
            {#each $pianos as piano (piano.id)}
              <option value={piano.id}>{piano.brand} {piano.model}</option>
            {/each}
          </select>
        </div>
        <div>
          <span class="label">调律日期</span>
          <input class="field" type="date" bind:value={form.date} />
        </div>
        <div>
          <span class="label">基准音高 Hz</span>
          <input class="field" type="number" step="0.1" bind:value={form.basePitchHz} oninput={recalc} />
        </div>
        <div>
          <span class="label">调律师</span>
          <input class="field" bind:value={form.technician} placeholder="如：陆师傅" />
        </div>
      </div>

      <div class="mt-4">
        <div class="mb-1 text-xs text-stone-500">各音区音分偏差（自动计算平均与最大值）</div>
        <div class="grid gap-3 md:grid-cols-3">
          {#each ZONE_LABELS as zone (zone.key)}
            <div>
              <span class="label">{zone.label}</span>
              <input
                class="field"
                type="number"
                step="0.1"
                bind:value={form.zones[zone.key]}
                oninput={recalc}
              />
            </div>
          {/each}
        </div>
      </div>

      {#if dialogMode === 'correct'}
        <div class="mt-4">
          <span class="label">更正说明（随新版本保存）</span>
          <input class="field" bind:value={correctionReason} placeholder="如：复测后修正低音区偏差" />
        </div>
      {/if}

      <div class="mt-4 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
        平均 {form.avgDeviationCents} 音分 · 最大 {form.maxDeviationCents} 音分 ·
        {form.pitchRaised ? '判定需二次复调' : '偏差在可接受区间'}
        {#if dialogSummary && dialogSummary.tuningCount > 0}
          <div class="mt-1 text-stone-400">
            该琴历史调律 {dialogSummary.tuningCount} 次，上次 {dialogSummary.lastTuningDate}
            （{dialogSummary.latestTuningId === editingId ? `当前 v${dialogSummary.latestVersion}` : ''}）
          </div>
        {/if}
      </div>

      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn" onclick={closeDialog}>取消</button>
        <button type="button" class="btn-primary" onclick={submit}>
          {dialogMode === 'correct' ? `确认更正为 v${expectedVersion + 1}` : '保存'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if historyOpen && historyTuning}
  <div class="modal-mask">
    <button type="button" class="absolute inset-0 cursor-default" aria-label="关闭弹窗" onclick={() => (historyOpen = false)}></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-1 text-base font-semibold">
        版本履历 · {pianoLabel(historyTuning.pianoId)} · {historyTuning.date}
      </h3>
      <p class="muted mb-3">前后版本均保留（原记录不删）；当前生效版本为 v{historyTuning.version}。</p>
      {#if historyLoading}
        <div class="py-6 text-center text-xs text-stone-400">加载中…</div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="border-b border-stone-200 text-left text-stone-500">
              <tr>
                <th class="py-2">版本</th>
                <th class="py-2">基准音高</th>
                <th class="py-2">平均 / 最大</th>
                <th class="py-2">低 / 中 / 高</th>
                <th class="py-2">调律师</th>
                <th class="py-2">更正说明 / 时间</th>
              </tr>
            </thead>
            <tbody>
              {#each historyRows as revision (revision.id)}
                <tr class="border-b border-stone-100 {revision.version === historyTuning.version ? 'bg-indigo-50/60' : ''}">
                  <td class="py-2 align-top">
                    v{revision.version}
                    {#if revision.version === historyTuning.version}
                      <div class="text-[10px] text-indigo-600">当前生效</div>
                    {/if}
                  </td>
                  <td class="py-2 align-top tabular-nums">{revision.basePitchHz} Hz</td>
                  <td class="py-2 align-top tabular-nums">{revision.avgDeviationCents} / {revision.maxDeviationCents}</td>
                  <td class="py-2 align-top tabular-nums">
                    {revision.zones.bass} / {revision.zones.mid} / {revision.zones.treble}
                  </td>
                  <td class="py-2 align-top">{revision.technician}</td>
                  <td class="py-2 align-top">
                    {#if revision.correctionReason}
                      <div>{revision.correctionReason}</div>
                    {:else}
                      <div class="text-stone-400">初版</div>
                    {/if}
                    {#if revision.correctedAt}
                      <div class="text-[10px] text-stone-400">{formatTimestamp(revision.correctedAt)}</div>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <div class="mt-5 flex justify-end">
        <button type="button" class="btn" onclick={() => (historyOpen = false)}>关闭</button>
      </div>
    </div>
  </div>
{/if}

{#if batchOpen}
  <div class="modal-mask">
    <button type="button" class="absolute inset-0 cursor-default" aria-label="关闭弹窗" onclick={() => (batchOpen = false)}></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-1 text-base font-semibold">批量确认更正</h3>
      <p class="muted mb-3">
        粘贴 JSON 数组（字段：id / date / basePitchHz / zones / technician / reason）。引用的钢琴不存在、记录缺失或字段非法时，本次整批不写入。
      </p>
      {#if batchError}
        <div class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{batchError}</div>
      {/if}
      {#if batchSuccess}
        <div class="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{batchSuccess}</div>
      {/if}
      <textarea class="field h-64 font-mono text-xs" bind:value={batchText} placeholder={BATCH_CORRECTION_TEMPLATE}></textarea>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn" onclick={() => (batchOpen = false)}>关闭</button>
        <button type="button" class="btn-primary" onclick={submitBatch} disabled={batchBusy}>
          {batchBusy ? '提交中…' : '确认批量更正'}
        </button>
      </div>
    </div>
  </div>
{/if}
