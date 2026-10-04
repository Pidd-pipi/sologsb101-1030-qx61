<script lang="ts">
  /** /tunings 调律记录：录入基准音高与各音区音分偏差、标记需复调；更正按版本链保存（原记录不删） */
  import { onMount } from 'svelte';
  import { push, router } from '$lib/router';
  import FilterBar from '$lib/components/common/FilterBar.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import CentsTag from '$lib/components/common/CentsTag.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import { summarizeCents } from '$lib/hooks/useCentsDeviation';
  import { db, type PianoRow, type TuningRow } from '$lib/utils/db';
  import {
    createEmptyTuning,
    REPITCH_AVG_THRESHOLD,
    REPITCH_MAX_THRESHOLD,
    STANDARD_PITCH_HZ,
    ZONE_LABELS,
    type Tuning,
    type TuningZones
  } from '$lib/types/tuning';
  import {
    batchCorrectTunings,
    correctTuning,
    createTuning,
    deleteTuning,
    resetTuningFilters,
    setTuningFilters,
    TUNING_FILTER_KEYS,
    tuningFilters
  } from '$lib/stores/tuningStore';
  import type { BatchCorrectItem } from '$lib/utils/db';
  import { bandColor, barHeight, centsFromStandardPitch, formatCents, needsRepitch } from '$lib/utils/cents';
  import type { FilterModel, FilterSelectConfig } from '$lib/types/filter';
  import { queryToFilters, toQueryString } from '$lib/utils/query';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const tunings = useIdbTable<TuningRow>(db.tunings, (a, b) => b.date.localeCompare(a.date));

  let dialogOpen = $state(false);
  let editingId = $state<string | null>(null);
  let editingBaseVersion = $state(1);
  let form = $state<Omit<Tuning, 'id' | 'version' | 'versions'>>(createEmptyTuning());
  let note = $state('');
  let formError = $state<string | null>(null);

  // 版本历史弹窗
  let historyOpen = $state(false);
  let historyTuning = $state<TuningRow | null>(null);

  // 批量更正弹窗
  interface BatchDraft {
    tuningId: string;
    baseVersion: number;
    pianoId: string;
    date: string;
    basePitchHz: number;
    zones: TuningZones;
    technician: string;
    note: string;
  }
  let batchOpen = $state(false);
  let batchRows = $state<BatchDraft[]>([]);
  let batchError = $state<string | null>(null);

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
      pianoCovered: new Set(all.map((item) => item.pianoId)).size
    };
  });

  /** 由三个音区偏差自动推导平均值、最大值与复调判定 */
  function deriveDeviations(zones: TuningZones): Pick<Tuning, 'avgDeviationCents' | 'maxDeviationCents' | 'pitchRaised'> {
    const values = [zones.bass, zones.mid, zones.treble];
    const avgDeviationCents = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
    const maxDeviationCents = Number(
      values.reduce((worst, value) => (Math.abs(value) > Math.abs(worst) ? value : worst), values[0]).toFixed(1)
    );
    return { avgDeviationCents, maxDeviationCents, pitchRaised: needsRepitch(avgDeviationCents, maxDeviationCents) };
  }

  function recalc(): void {
    const derived = deriveDeviations(form.zones);
    form.avgDeviationCents = derived.avgDeviationCents;
    form.maxDeviationCents = derived.maxDeviationCents;
    form.pitchRaised = derived.pitchRaised;
  }

  function openCreate(): void {
    editingId = null;
    editingBaseVersion = 1;
    note = '';
    form = createEmptyTuning();
    if ($pianos.length > 0) form.pianoId = $pianos[0].id;
    formError = null;
    dialogOpen = true;
  }

  function openEdit(tuning: TuningRow): void {
    editingId = tuning.id;
    editingBaseVersion = tuning.version;
    note = '';
    form = {
      pianoId: tuning.pianoId,
      date: tuning.date,
      basePitchHz: tuning.basePitchHz,
      avgDeviationCents: tuning.avgDeviationCents,
      maxDeviationCents: tuning.maxDeviationCents,
      zones: { ...tuning.zones },
      technician: tuning.technician,
      pitchRaised: tuning.pitchRaised
    };
    formError = null;
    dialogOpen = true;
  }

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
    recalc();
    const payload = { ...form, zones: { ...form.zones } };
    if (editingId) {
      // 确认更正：携带起始版本做乐观并发控制。冲突时保留草稿并提示版本已变化。
      const result = await correctTuning(editingId, editingBaseVersion, payload, note.trim() || undefined);
      if (result.status === 'conflict') {
        formError = `该调律记录已被其他标签页修改（版本已变化，当前为 v${result.current.version}）。草稿已保留，请关闭后重新打开编辑。`;
        return;
      }
    } else {
      await createTuning(payload);
    }
    dialogOpen = false;
  }

  async function remove(tuning: TuningRow): Promise<void> {
    if (!window.confirm(`删除 ${tuning.date} 的调律记录？`)) return;
    await deleteTuning(tuning.id);
  }

  function openHistory(tuning: TuningRow): void {
    historyTuning = tuning;
    historyOpen = true;
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ------------------------------ 批量更正 ------------------------------ */

  function openBatch(): void {
    batchRows = [];
    batchError = null;
    batchOpen = true;
    addBatchRow();
  }

  function addBatchRow(): void {
    const first = $tunings[0];
    batchRows = [
      ...batchRows,
      first
        ? {
            tuningId: first.id,
            baseVersion: first.version,
            pianoId: first.pianoId,
            date: first.date,
            basePitchHz: first.basePitchHz,
            zones: { ...first.zones },
            technician: first.technician,
            note: ''
          }
        : {
            tuningId: '',
            baseVersion: 1,
            pianoId: '',
            date: '',
            basePitchHz: STANDARD_PITCH_HZ,
            zones: { bass: 0, mid: 0, treble: 0 },
            technician: '',
            note: ''
          }
    ];
  }

  function onBatchTuningChange(row: BatchDraft): void {
    const tuning = $tunings.find((item) => item.id === row.tuningId);
    if (!tuning) return;
    row.baseVersion = tuning.version;
    row.pianoId = tuning.pianoId;
    row.date = tuning.date;
    row.basePitchHz = tuning.basePitchHz;
    row.zones = { ...tuning.zones };
    row.technician = tuning.technician;
  }

  function removeBatchRow(index: number): void {
    batchRows = batchRows.filter((_, i) => i !== index);
  }

  async function submitBatch(): Promise<void> {
    batchError = null;
    const items: BatchCorrectItem[] = [];
    for (const row of batchRows) {
      if (!row.tuningId) {
        batchError = '请为每一行选择调律记录';
        return;
      }
      if (!row.technician.trim()) {
        batchError = '请填写调律师';
        return;
      }
      const derived = deriveDeviations(row.zones);
      items.push({
        tuningId: row.tuningId,
        baseVersion: row.baseVersion,
        note: row.note.trim() || undefined,
        patch: {
          basePitchHz: row.basePitchHz,
          zones: { ...row.zones },
          technician: row.technician,
          ...derived
        }
      });
    }
    const result = await batchCorrectTunings(items);
    if (result.status === 'aborted') {
      batchError = result.reason;
      return;
    }
    batchOpen = false;
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
      </p>
    </div>
    <div class="flex gap-2">
      <button type="button" class="btn" onclick={openBatch} disabled={$tunings.length === 0}>批量更正</button>
      <button type="button" class="btn-primary" onclick={openCreate} disabled={$pianos.length === 0}>+ 新增调律记录</button>
    </div>
  </div>

  <div class="badge-row">
    <StatBadge label="调律次数" value={totals.tuningCount} suffix="次" tone="walnut" icon="🎼" />
    <StatBadge label="需复调" value={totals.repitchCount} suffix="次" tone="rose" icon="!" />
    <StatBadge label="复调占比" value={totals.repitchRatio} percent={totals.repitchRatio} showPercent tone="amber" icon="%" />
    <StatBadge label="平均偏差" value={totals.avgDeviation} suffix="音分" tone="brass" icon="≈" />
    <StatBadge label="最大偏差" value={totals.maxDeviation} suffix="音分" tone="slate" icon="‼" />
    <StatBadge label="覆盖钢琴" value={totals.pianoCovered} suffix="台" tone="green" icon="🎹" />
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
        <span class="muted">以 ±40 音分为满格</span>
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
            <th class="py-2">版本</th>
            <th class="py-2">基准音高</th>
            <th class="py-2">平均偏差</th>
            <th class="py-2">最大偏差</th>
            <th class="py-2">低 / 中 / 高音区</th>
            <th class="py-2">调律师</th>
            <th class="py-2">复调</th>
            <th class="py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as tuning (tuning.id)}
            <tr class="border-b border-stone-100">
              <td class="py-2">{pianoLabel(tuning.pianoId)}</td>
              <td class="py-2">{tuning.date}</td>
              <td class="py-2">
                <button type="button" class="btn px-2 py-0.5 text-xs" onclick={() => openHistory(tuning)}>
                  v{tuning.version} · {tuning.versions.length} 版
                </button>
              </td>
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
                <button type="button" class="btn mr-2" onclick={() => openEdit(tuning)}>更正</button>
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
      onclick={() => (dialogOpen = false)}
    ></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-4 text-base font-semibold">
        {editingId ? `更正调律记录 · v${editingBaseVersion}` : '新增调律记录'}
      </h3>
      {#if formError}
        <div class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{formError}</div>
      {/if}

      <div class="grid gap-3 md:grid-cols-2">
        <div>
          <span class="label">钢琴</span>
          <select class="field" bind:value={form.pianoId} onchange={recalc}>
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

      {#if editingId}
        <div class="mt-4">
          <span class="label">更正备注（可选）</span>
          <input class="field" bind:value={note} placeholder="如：更正低音区偏差" />
        </div>
      {/if}

      <div class="mt-4 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
        平均 {form.avgDeviationCents} 音分 · 最大 {form.maxDeviationCents} 音分 ·
        {form.pitchRaised ? '判定需二次复调' : '偏差在可接受区间'}
        {#if dialogSummary && dialogSummary.tuningCount > 0}
          <div class="mt-1 text-stone-400">该琴历史调律 {dialogSummary.tuningCount} 次，上次 {dialogSummary.lastTuningDate}</div>
        {/if}
      </div>

      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button type="button" class="btn-primary" onclick={submit}>
          {editingId ? '确认更正（生成新版本）' : '保存'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if historyOpen && historyTuning}
  <div class="modal-mask">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      aria-label="关闭弹窗"
      onclick={() => (historyOpen = false)}
    ></button>
    <div class="modal-panel relative" role="dialog" aria-modal="true">
      <h3 class="mb-4 text-base font-semibold">
        版本历史 · {pianoLabel(historyTuning.pianoId)} · {historyTuning.date}
      </h3>
      <div class="max-h-96 space-y-3 overflow-y-auto">
        {#each historyTuning.versions as version (version.version)}
          <div class="rounded-lg border {version.version === historyTuning!.version ? 'border-walnut bg-walnut-50/40' : 'border-stone-200'} px-3 py-2">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-sm font-semibold">
                v{version.version}
                {#if version.version === historyTuning!.version}
                  <span class="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">当前</span>
                {/if}
              </span>
              <span class="text-xs text-stone-400">{formatTime(version.confirmedAt)}</span>
            </div>
            <div class="grid gap-1 text-xs text-stone-600 md:grid-cols-2">
              <div>日期：{version.date}</div>
              <div>调律师：{version.technician}</div>
              <div>基准音高：{version.basePitchHz} Hz（{formatCents(centsFromStandardPitch(version.basePitchHz))}）</div>
              <div>平均 / 最大：{version.avgDeviationCents} / {version.maxDeviationCents} 音分</div>
              <div class="md:col-span-2">
                低 / 中 / 高音区：{version.zones.bass} / {version.zones.mid} / {version.zones.treble} 音分
              </div>
              <div class="md:col-span-2">
                {#if version.pitchRaised}
                  <span class="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">需复调</span>
                {:else}
                  <span class="text-stone-400">偏差正常</span>
                {/if}
                {#if version.note}
                  <span class="ml-2 text-stone-500">备注：{version.note}</span>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
      <div class="mt-5 flex justify-end">
        <button type="button" class="btn" onclick={() => (historyOpen = false)}>关闭</button>
      </div>
    </div>
  </div>
{/if}

{#if batchOpen}
  <div class="modal-mask">
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      aria-label="关闭弹窗"
      onclick={() => (batchOpen = false)}
    ></button>
    <div class="modal-panel relative max-w-4xl" role="dialog" aria-modal="true">
      <h3 class="mb-1 text-base font-semibold">批量更正调律记录</h3>
      <p class="mb-3 text-xs text-stone-500">
        按前后版本保存基准音高与音区偏差，原记录不删；任一条目引用的钢琴不存在或版本已变化，则整批不写入。
      </p>
      {#if batchError}
        <div class="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{batchError}</div>
      {/if}
      <div class="max-h-80 space-y-3 overflow-y-auto">
        {#each batchRows as row, index (index)}
          <div class="rounded-lg border border-stone-200 p-3">
            <div class="mb-2 flex items-center justify-between">
              <span class="text-xs font-semibold text-stone-500">第 {index + 1} 条 · 起始 v{row.baseVersion}</span>
              <button type="button" class="text-xs text-rose-600" onclick={() => removeBatchRow(index)}>移除</button>
            </div>
            <div class="grid gap-2 md:grid-cols-3">
              <div class="md:col-span-3">
                <span class="label">调律记录</span>
                <select class="field" bind:value={row.tuningId} onchange={() => onBatchTuningChange(row)}>
                  {#each $tunings as tuning (tuning.id)}
                    <option value={tuning.id}>{pianoLabel(tuning.pianoId)} · {tuning.date}（v{tuning.version}）</option>
                  {/each}
                </select>
              </div>
              <div>
                <span class="label">基准音高 Hz</span>
                <input class="field" type="number" step="0.1" bind:value={row.basePitchHz} />
              </div>
              <div>
                <span class="label">调律师</span>
                <input class="field" bind:value={row.technician} />
              </div>
              <div>
                <span class="label">更正备注</span>
                <input class="field" bind:value={row.note} placeholder="可选" />
              </div>
              {#each ZONE_LABELS as zone (zone.key)}
                <div>
                  <span class="label">{zone.label} 音分</span>
                  <input class="field" type="number" step="0.1" bind:value={row.zones[zone.key]} />
                </div>
              {/each}
            </div>
            <div class="mt-2 text-xs text-stone-500">
              更正后平均 {deriveDeviations(row.zones).avgDeviationCents} 音分 · 最大 {deriveDeviations(row.zones).maxDeviationCents} 音分 ·
              {deriveDeviations(row.zones).pitchRaised ? '需复调' : '正常'}
            </div>
          </div>
        {/each}
      </div>
      <div class="mt-3">
        <button type="button" class="btn" onclick={addBatchRow}>+ 添加一条更正</button>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn" onclick={() => (batchOpen = false)}>取消</button>
        <button type="button" class="btn-primary" onclick={submitBatch}>确认批量更正</button>
      </div>
    </div>
  </div>
{/if}
