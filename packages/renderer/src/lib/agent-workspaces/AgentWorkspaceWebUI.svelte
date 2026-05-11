<script lang="ts">
import { faArrowsRotate, faTerminal } from '@fortawesome/free-solid-svg-icons';
import { Button, EmptyScreen } from '@podman-desktop/ui-svelte';

import { agentWorkspaceTerminals } from '/@/stores/agent-workspace-terminal-store';

interface Props {
  workspaceId: string;
  isRunning: boolean;
}

let { workspaceId, isRunning }: Props = $props();

let webuiUrl: string | undefined = $state(undefined);
let loading = $state(false);
let error: string | undefined = $state(undefined);

const terminalActive = $derived(
  $agentWorkspaceTerminals.some(t => t.workspaceId === workspaceId && t.callbackId !== undefined),
);

async function resolveUrl(): Promise<void> {
  loading = true;
  error = undefined;
  webuiUrl = undefined;

  try {
    const url = await window.getAgentWorkspaceWebUIUrl(workspaceId);
    webuiUrl = url;
  } catch (err: unknown) {
    error = String(err);
  } finally {
    loading = false;
  }
}

$effect(() => {
  if (isRunning && terminalActive) {
    resolveUrl().catch((err: unknown) => console.error('Failed to resolve WebUI URL', err));
  } else {
    webuiUrl = undefined;
    error = undefined;
  }
});
</script>

{#if !isRunning}
  <EmptyScreen
    icon={faTerminal}
    title="Workspace Not Running"
    message="Start the workspace to access the WebUI" />
{:else if !terminalActive}
  <EmptyScreen
    icon={faTerminal}
    title="Gateway Not Running"
    message="Open the Terminal tab first to start the gateway" />
{:else if loading}
  <EmptyScreen
    icon={faArrowsRotate}
    title="Loading WebUI"
    message="Resolving gateway address..." />
{:else if error}
  <EmptyScreen
    icon={faTerminal}
    title="WebUI Unavailable"
    message={error}>
    {#snippet upperContent()}
      <div class="flex justify-center mt-3">
        <Button type="link" onclick={resolveUrl}>Retry</Button>
      </div>
    {/snippet}
  </EmptyScreen>
{:else if webuiUrl}
  <webview
    src={webuiUrl}
    style="height: 100%; width: 100%"></webview>
{/if}
