<script lang="ts">
import { Button, ErrorMessage, Input, NumberInput } from '@podman-desktop/ui-svelte';

import Dialog from '/@/lib/dialogs/Dialog.svelte';
import { openshellGateways } from '/@/stores/openshell-gateways';
import { GATEWAY_NAME_PATTERN } from '/@api/openshell-gateway-info';

interface Props {
  existingNames: string[];
  closeCallback: () => void;
}

let { existingNames, closeCallback }: Props = $props();

let name = $state('local-gateway');
let bindAddress = $state('127.0.0.1');
let port = $state(17675);
let creating = $state(false);
let error = $state('');
let checkingPort = $state(true);
let portAvailabilityError = $state('');

let nameError = $derived.by((): string => {
  if (!name.trim()) return 'Enter a gateway name';
  if (!GATEWAY_NAME_PATTERN.test(name.trim())) {
    return 'Use lowercase letters, numbers, dots, dashes, or underscores';
  }
  if (existingNames.includes(name.trim())) return 'A gateway with this name already exists';
  return '';
});
let portError = $derived(
  !Number.isInteger(port) || port < 1 || port > 65_535 ? 'Enter a port between 1 and 65535' : '',
);
let bindAddressError = $derived(bindAddress.trim() ? '' : 'Enter a bind address');
let canCreate = $derived(
  !nameError && !bindAddressError && !portError && !portAvailabilityError && !checkingPort && !creating,
);

$effect(() => {
  const selectedPort = port;
  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65_535) {
    checkingPort = false;
    portAvailabilityError = '';
    return;
  }

  checkingPort = true;
  portAvailabilityError = '';
  window.isFreePort(selectedPort).then(
    () => {
      if (port === selectedPort) checkingPort = false;
    },
    () => {
      if (port === selectedPort) {
        checkingPort = false;
        portAvailabilityError = `Port ${selectedPort} is already in use`;
      }
    },
  );
});

async function createGateway(): Promise<void> {
  if (!canCreate) return;
  creating = true;
  error = '';
  try {
    openshellGateways.set(
      await window.createLocalGateway({ name: name.trim(), bindAddress: bindAddress.trim(), port }),
    );
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
    <div class="w-[28rem] max-w-full">
      <label for="gateway-name" class="block mb-2 text-sm font-semibold">Name</label>
      <Input id="gateway-name" aria-label="Gateway name" bind:value={name} aria-invalid={nameError !== ''} />
      {#if nameError}<ErrorMessage error={nameError} />{/if}

      <label for="gateway-bind-address" class="block mt-5 mb-2 text-sm font-semibold">Bind address</label>
      <Input
        id="gateway-bind-address"
        aria-label="Gateway bind address"
        bind:value={bindAddress}
        aria-invalid={bindAddressError !== ''} />
      {#if bindAddressError}<ErrorMessage error={bindAddressError} />{/if}

      <label class="block mt-5 mb-2 text-sm font-semibold">
        <span class="block mb-2">Port</span>
        <NumberInput
          name="gateway-port"
          aria-label="Gateway port"
          bind:value={port}
          minimum={1}
          maximum={65535}
          type="integer"
          showError={false} />
      </label>
      <p class="mt-1 text-xs opacity-70">Suggested port: 17675.</p>
      {#if portError}<ErrorMessage error={portError} />{/if}
      {#if portAvailabilityError}<ErrorMessage error={portAvailabilityError} />{/if}
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
