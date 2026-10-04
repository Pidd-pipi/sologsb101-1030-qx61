<script lang="ts">
  /**
   * VersionTag：调律版本链徽标。
   * v1 显示初版；v2+ 显示当前版本与「已更正 N 次」，被调律记录页与钢琴台账消费。
   */
  let {
    version,
    size = 'sm',
    showCorrections = true
  }: {
    version: number;
    size?: 'xs' | 'sm';
    showCorrections?: boolean;
  } = $props();

  const corrected = $derived(version > 1);
  const sizeClass = $derived(size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs');
</script>

{#if corrected}
  <span class="inline-flex items-center gap-1 rounded-full bg-indigo-100 font-medium text-indigo-700 {sizeClass}" title="该调律记录已按新版本更正，历史版本保留在版本履历中">
    <span aria-hidden="true">v{version}</span>
    {#if showCorrections}
      <span class="opacity-70">· 已更正 {version - 1} 次</span>
    {/if}
  </span>
{:else}
  <span class="inline-flex items-center rounded-full bg-stone-100 text-stone-500 {sizeClass}" title="初版记录">
    v1
  </span>
{/if}
