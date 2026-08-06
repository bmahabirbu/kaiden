<script lang="ts">
import { Button, ErrorMessage, Input, NumberInput } from '@podman-desktop/ui-svelte';
import { onMount } from 'svelte';

import Dialog from '/@/lib/dialogs/Dialog.svelte';
import SlideToggle from '/@/lib/ui/SlideToggle.svelte';
import { openshellGateways } from '/@/stores/openshell-gateways';

import { getBindMountsEnabled, setBindMountsEnabled } from './openshell-gateway-config';

interface Props {
  existingNames: string[];
  closeCallback: () => void;
}

let { existingNames, closeCallback }: Props = $props();

let selectedTab: 'general' | 'config' = $state('general');
let name = $state('local-gateway');
let port = $state(17675);
let config = $state('');
let configName = $state('');
let loadingConfig = $state(false);
let creating = $state(false);
let error = $state('');
let configLoadTimeout: ReturnType<typeof setTimeout> | undefined;

let nameError = $derived.by((): string => {
  if (!name.trim()) return 'Enter a gateway name';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name.trim())) {
    return 'Use lowercase letters, numbers, dots, dashes, or underscores';
  }
  if (existingNames.includes(name.trim())) return 'A gateway with this name already exists';
  return '';
});
let portError = $derived(
  !Number.isInteger(port) || port < 1 || port > 65_535 ? 'Enter a port between 1 and 65535' : '',
);
let bindMountsEnabled = $derived(getBindMountsEnabled(config));
let canCreate = $derived(!nameError && !portError && config.trim() !== '' && !loadingConfig && !creating);

function updateName(value: string): void {
  name = value;
  if (configName !== value.trim()) {
    config = '';
    configName = '';
  }
  clearTimeout(configLoadTimeout);
  configLoadTimeout = setTimeout(() => {
    loadConfig().catch(() => {});
  }, 250);
}

function selectGeneralTab(): void {
  selectedTab = 'general';
}

async function loadConfig(): Promise<void> {
  error = '';
  if (nameError || (config && configName === name.trim())) return;
  const requestedName = name.trim();
  loadingConfig = true;
  try {
    const generatedConfig = await window.getLocalGatewayConfig(requestedName);
    if (name.trim() === requestedName) {
      config = generatedConfig;
      configName = requestedName;
    }
  } catch (cause: unknown) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loadingConfig = false;
  }
}

async function selectConfigTab(): Promise<void> {
  selectedTab = 'config';
  await loadConfig();
}

function updateConfig(value: string): void {
  config = value;
}

function toggleBindMounts(): void {
  const updated = setBindMountsEnabled(config, !bindMountsEnabled);
  if (updated === config && !/^\s*\[openshell\.drivers\.[^\]]+\]\s*$/m.test(config)) {
    error = 'Add an [openshell.drivers.<driver>] section before enabling bind mounts';
    return;
  }
  config = updated;
  error = '';
}

onMount(() => {
  loadConfig().catch(() => {});
});

async function createGateway(): Promise<void> {
  if (!canCreate) return;
  creating = true;
  error = '';
  try {
    openshellGateways.set(await window.createLocalGateway({ name: name.trim(), port, config }));
    closeCallback();
  } catch (cause: unknown) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    creating = false;
  }
}
</script>

<Dialog title="Create local gateway" onclose={closeCallback}>
  {#snippet content()}
    <div class="w-[36rem] max-w-full">
      <div class="flex border-b border-[var(--pd-content-divider)] mb-5" role="tablist">
        <Button type="tab" selected={selectedTab === 'general'} onclick={selectGeneralTab}>
          General
        </Button>
        <Button type="tab" selected={selectedTab === 'config'} onclick={selectConfigTab}>Config</Button>
      </div>

      {#if selectedTab === 'general'}
        <label for="gateway-name" class="block mb-2 text-sm font-semibold">Name</label>
        <Input
          id="gateway-name"
          aria-label="Gateway name"
          value={name}
          oninput={(event: Event): void => updateName((event.currentTarget as HTMLInputElement).value)}
          aria-invalid={nameError !== ''} />
        {#if nameError}<ErrorMessage error={nameError} />{/if}

        <label for="gateway-port" class="block mt-5 mb-2 text-sm font-semibold">Port</label>
        <NumberInput
          name="gateway-port"
          aria-label="Gateway port"
          bind:value={port}
          minimum={1}
          maximum={65535}
          type="integer"
          showError={false} />
        <p class="mt-1 text-xs opacity-70">Suggested port: 17675. Availability is checked when the gateway starts.</p>
        {#if portError}<ErrorMessage error={portError} />{/if}
      {:else}
        {#if loadingConfig}
          <p class="py-8 text-center text-sm">Generating gateway configuration…</p>
        {:else}
          <div class="flex items-start justify-between gap-5 mb-3">
            <div>
              <div class="text-sm font-semibold">Gateway config (TOML)</div>
              <p class="text-xs opacity-70">Kaiden generates this configuration; you can edit it before creation.</p>
            </div>
            <SlideToggle
              id="gateway-bind-mounts"
              checked={bindMountsEnabled}
              disabled={!config}
              on:checked={toggleBindMounts}>
              Enable bind mounts
            </SlideToggle>
          </div>
          <textarea
            aria-label="Gateway config TOML"
            class="w-full h-64 resize-y rounded-md border border-[var(--pd-input-field-border)] bg-[var(--pd-input-field-bg)] text-[var(--pd-input-field-text)] p-3 font-mono text-xs"
            value={config}
            spellcheck="false"
            oninput={(event): void => updateConfig(event.currentTarget.value)}></textarea>
        {/if}
      {/if}
    </div>
  {/snippet}

  {#snippet validation()}
    {#if error}<ErrorMessage error={error} />{/if}
  {/snippet}

  {#snippet buttons()}
    <Button type="secondary" onclick={closeCallback} disabled={creating}>Cancel</Button>
    <Button onclick={createGateway} disabled={!canCreate}>{creating ? 'Creating…' : 'Create'}</Button>
  {/snippet}
</Dialog>
