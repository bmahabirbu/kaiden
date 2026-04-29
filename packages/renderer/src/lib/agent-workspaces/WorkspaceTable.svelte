<script lang="ts">
import type { AgentWorkspaceSummaryUI } from '/@/stores/agent-workspaces.svelte';

import AgentWorkspaceRow from './AgentWorkspaceRow.svelte';
import { isActiveWorkspace } from './workspace-utils';

interface Props {
  workspaces: AgentWorkspaceSummaryUI[];
}

let { workspaces }: Props = $props();

const groups = $derived({
  active: workspaces.filter(isActiveWorkspace),
  stopped: workspaces.filter(w => !isActiveWorkspace(w)),
});
</script>

<div class="workspace-table">
  <div class="workspace-header grid items-center px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide opacity-50 bg-[var(--pd-invert-content-card-bg)] border-b border-[var(--pd-content-card-border)]">
    <span></span>
    <span>Workspace</span>
    <span>Context</span>
    <span class="text-right">Time</span>
    <span></span>
  </div>

  {#each Object.entries(groups) as [label, list] (label)}
    {#if list.length}
      <div class="px-5 pt-3 pb-1 text-[11px] font-semibold uppercase opacity-50 bg-[var(--pd-invert-content-card-bg)]">{label}</div>
      {#each list as workspace (workspace.id)}
        <AgentWorkspaceRow object={workspace} />
      {/each}
    {/if}
  {/each}
</div>

<style>
  .workspace-table {
    --ws-grid: 44px 1fr 160px 80px 96px;
    --ws-gap: 20px;
    background: var(--pd-content-card-bg);
    border: 1px solid var(--pd-content-card-border);
    border-radius: 14px;
    overflow: hidden;
  }

  .workspace-header {
    grid-template-columns: var(--ws-grid);
    gap: var(--ws-gap);
  }
</style>
