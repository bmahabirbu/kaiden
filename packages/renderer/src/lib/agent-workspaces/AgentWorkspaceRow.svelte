<script lang="ts">
import { onDestroy } from 'svelte';
import { router } from 'tinro';

import type { AgentWorkspaceSummaryUI } from '/@/stores/agent-workspaces.svelte';

import AgentWorkspaceActions from './AgentWorkspaceActions.svelte';
import AgentWorkspaceIcon from './columns/AgentWorkspaceIcon.svelte';

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
  class="group grid grid-cols-[44px_minmax(0,1fr)_200px_56px_80px] gap-x-5 items-center w-full text-left px-[22px] py-3.5 cursor-pointer border-b border-b-[var(--pd-content-card-border)]/65 bg-transparent text-inherit last:border-b-0 hover:bg-[var(--pd-content-card-hover-bg)] focus-within:bg-[var(--pd-content-card-hover-bg)]"
  role="row"
  tabindex="0"
  onclick={openDetails}
  onkeydown={handleKeydown}>

  <div class="flex items-center">
    <AgentWorkspaceIcon {object} />
  </div>

  <div class="flex flex-col gap-1.5 min-w-0">
    <div
      class="text-lg font-semibold text-[var(--pd-content-text)] leading-normal overflow-hidden text-ellipsis whitespace-nowrap group-hover:text-[var(--pd-link)]"
      title={object.name}>
      {object.name}
    </div>
    {#if object.model}
      <div class="text-base text-[var(--pd-content-text)] opacity-60 overflow-hidden text-ellipsis whitespace-nowrap">
        {object.model}
      </div>
    {/if}
    <div class="flex gap-1.5 flex-wrap items-center">
      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-[var(--pd-status-running)] bg-[color-mix(in_srgb,var(--pd-status-running)_12%,transparent)]">
        {agentLabel}
      </span>
    </div>
  </div>

  <div class="min-w-0 flex items-center gap-1.5">
    <span
      class="w-[7px] h-[7px] rounded-full shrink-0"
      class:bg-[var(--pd-status-running)]={isRunning}
      class:animate-pulse={isRunning || isTransitioning}
      class:bg-[var(--pd-status-waiting)]={isTransitioning}
      class:bg-[var(--pd-status-terminated)]={!isRunning && !isTransitioning}>
    </span>
    <span class="text-xs font-medium text-[var(--pd-content-text)] opacity-50">
      {statusLabel}
    </span>
  </div>

  <div class="justify-self-end text-xs text-[var(--pd-content-text)] opacity-50 font-semibold tabular-nums">
    {#if timeLabel}
      <span>{timeLabel}</span>
    {:else}
      <span>&mdash;</span>
    {/if}
  </div>

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="justify-self-end flex gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" onclick={(e: MouseEvent): void => e.stopPropagation()}>
    <AgentWorkspaceActions {object} />
  </div>
</div>
