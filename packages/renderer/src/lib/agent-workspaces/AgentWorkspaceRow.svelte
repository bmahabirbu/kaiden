<script lang="ts">
import { onDestroy } from 'svelte';
import { router } from 'tinro';

import AgentWorkspaceIcon from '/@/lib/agent-workspaces/columns/AgentWorkspaceIcon.svelte';
import type { AgentWorkspaceSummaryUI } from '/@/stores/agent-workspaces.svelte';

import AgentWorkspaceActions from './AgentWorkspaceActions.svelte';

interface Props {
  object: AgentWorkspaceSummaryUI;
}

let { object }: Props = $props();

const isRunning = $derived(object.state === 'running');
const isTransitioning = $derived(object.state === 'starting' || object.state === 'stopping');
const statusLabel = $derived(object.state.charAt(0).toUpperCase() + object.state.slice(1));
const agentLabel = $derived(object.agent.charAt(0).toUpperCase() + object.agent.slice(1));

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatElapsed(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

function computeRefreshInterval(elapsedMs: number): number {
  if (elapsedMs < MINUTE - 2 * SECOND) return 2 * SECOND;
  if (elapsedMs < HOUR) return Math.ceil((elapsedMs + 1) / MINUTE) * MINUTE - elapsedMs;
  if (elapsedMs < DAY) return Math.ceil((elapsedMs + 1) / HOUR) * HOUR - elapsedMs;
  return Math.ceil((elapsedMs + 1) / DAY) * DAY - elapsedMs;
}

let timeLabel = $state<string | undefined>(undefined);
let timeout: ReturnType<typeof setTimeout> | undefined;

function refreshTimeLabel(): void {
  const ts = object.timestamps;
  const refTime = ts?.started ?? ts?.created;
  if (!refTime) {
    timeLabel = undefined;
    return;
  }
  const elapsed = Date.now() - refTime;
  timeLabel = formatElapsed(elapsed);

  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(refreshTimeLabel, computeRefreshInterval(elapsed));
}

$effect(() => {
  refreshTimeLabel();
  return (): void => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
});

onDestroy(() => {
  if (timeout) clearTimeout(timeout);
});

function openDetails(): void {
  router.goto(`/agent-workspaces/${encodeURIComponent(object.id)}/summary`);
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openDetails();
  }
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="workspace-row group"
  role="button"
  tabindex="0"
  onclick={openDetails}
  onkeydown={handleKeydown}>

  <AgentWorkspaceIcon {object} />

  <div class="flex flex-col min-w-0 gap-1">
    <div class="text-sm font-semibold truncate group-hover:text-[var(--pd-link)]" title={object.name}>
      {object.name}
    </div>
    <div class="flex items-center gap-2 text-xs opacity-60 min-w-0">
      {#if object.model}
        <span class="truncate">{object.model}</span>
      {/if}
      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium text-[var(--pd-status-running)] bg-[color-mix(in_srgb,var(--pd-status-running)_12%,transparent)]">
        {agentLabel}
      </span>
    </div>
  </div>

  <span
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium w-fit"
    class:text-[var(--pd-status-running)]={isRunning}
    class:bg-[color-mix(in_srgb,var(--pd-status-running)_12%,transparent)]={isRunning}
    class:animate-pulse={isTransitioning}
    class:text-[var(--pd-status-waiting)]={isTransitioning}
    class:bg-[color-mix(in_srgb,var(--pd-status-waiting)_12%,transparent)]={isTransitioning}
    class:text-[var(--pd-status-terminated)]={!isRunning && !isTransitioning}
    class:bg-[color-mix(in_srgb,var(--pd-status-terminated)_12%,transparent)]={!isRunning && !isTransitioning}>
    <span class="w-1.5 h-1.5 rounded-full bg-current"></span>
    {statusLabel}
  </span>

  <div class="text-xs opacity-50 font-semibold tabular-nums text-right">
    {timeLabel ?? '—'}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="flex justify-end gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition" onclick={(e: MouseEvent): void => e.stopPropagation()} onkeydown={(e: KeyboardEvent): void => e.stopPropagation()}>
    <AgentWorkspaceActions {object} />
  </div>
</div>

<style>
  .workspace-row {
    display: grid;
    grid-template-columns: var(--ws-grid);
    gap: var(--ws-gap);
    align-items: center;
    padding: 14px 20px;
    cursor: pointer;
  }

  .workspace-row:hover {
    background: var(--pd-content-card-hover-bg);
  }
</style>
