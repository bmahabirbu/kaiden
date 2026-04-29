<script lang="ts">
import Fa from 'svelte-fa';

import { getAgentDefinition } from '/@/lib/guided-setup/agent-registry';
import type { AgentWorkspaceSummaryUI } from '/@/stores/agent-workspaces.svelte';

interface Props {
  object: AgentWorkspaceSummaryUI;
}

let { object }: Props = $props();

const agentDef = $derived(getAgentDefinition(object.agent));
</script>

<div class="w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0 {agentDef.colorClass}" title={object.agent}>
  <Fa icon={agentDef.icon} size="1x" color="#fff" />
</div>
