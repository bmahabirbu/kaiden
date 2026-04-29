<script lang="ts">
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { Button, FilteredEmptyScreen, NavPage, SearchInput } from '@podman-desktop/ui-svelte';

import NoLogIcon from '/@/lib/ui/NoLogIcon.svelte';
import { handleNavigation } from '/@/navigation';
import { agentWorkspaces, type AgentWorkspaceSummaryUI } from '/@/stores/agent-workspaces.svelte';
import { NavigationPage } from '/@api/navigation-page';

import AgentWorkspaceEmptyScreen from './AgentWorkspaceEmptyScreen.svelte';
import AgentWorkspaceStatCards from './AgentWorkspaceStatCards.svelte';
import WorkspaceTable from './WorkspaceTable.svelte';

let searchTerm = $state('');

function navigateToCreate(): void {
  handleNavigation({ page: NavigationPage.AGENT_WORKSPACE_CREATE });
}

const filteredWorkspaces: AgentWorkspaceSummaryUI[] = $derived.by(() => {
  const term = searchTerm.toLowerCase();
  return $agentWorkspaces.filter(
    ws =>
      !term ||
      ws.name.toLowerCase().includes(term) ||
      ws.project.toLowerCase().includes(term) ||
      (ws.model?.toLowerCase().includes(term) ?? false),
  );
});
</script>

<NavPage bind:searchTerm={searchTerm} searchEnabled={false} title="Agentic Workspaces">
  {#snippet additionalActions()}
    <Button icon={faPlus} onclick={navigateToCreate}>Create Workspace</Button>
  {/snippet}

  {#snippet content()}
    <div class="flex flex-col min-w-full h-full px-5 pt-4 pb-6 overflow-auto">
      <AgentWorkspaceStatCards workspaces={$agentWorkspaces} />

      <div
        class="mb-5 w-full"
        style="--pd-input-field-bg: var(--pd-content-card-bg); --pd-input-field-hover-bg: var(--pd-content-card-bg); --pd-input-field-focused-bg: var(--pd-content-card-bg);">
        <SearchInput bind:searchTerm={searchTerm} title="Agentic Workspaces" />
      </div>

      {#if filteredWorkspaces.length === 0}
        {#if searchTerm}
          <FilteredEmptyScreen icon={NoLogIcon} kind="sessions" bind:searchTerm={searchTerm} />
        {:else}
          <AgentWorkspaceEmptyScreen />
        {/if}
      {:else}
        <WorkspaceTable workspaces={filteredWorkspaces} />
      {/if}
    </div>
  {/snippet}
</NavPage>
