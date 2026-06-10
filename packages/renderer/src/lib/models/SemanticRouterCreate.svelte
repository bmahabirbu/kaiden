<script lang="ts">
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { Button, ErrorMessage, Input, NumberInput } from '@podman-desktop/ui-svelte';
import { Icon } from '@podman-desktop/ui-svelte/icons';

import FormPage from '/@/lib/ui/FormPage.svelte';
import WizardStepper from '/@/lib/ui/WizardStepper.svelte';
import { handleNavigation } from '/@/navigation';
import { NavigationPage } from '/@api/navigation-page';
import type { SemanticRouterConfigInfo } from '/@api/semantic-router-info';

const WIZARD_STEPS = [
  { id: 'basic', title: 'Basic setup' },
  { id: 'backends', title: 'Backend models' },
  { id: 'signals', title: 'Signals & decisions' },
  { id: 'advanced', title: 'Advanced & review' },
];

let name = $state('');
let description = $state('');
let listenerAddress = $state('0.0.0.0');
let listenerPort = $state(8899);
let timeout = $state('300s');

let saving = $state(false);
let error = $state('');

let canSave = $derived(name.trim().length > 0 && listenerPort >= 1024 && listenerPort <= 65535);

function cancel(): void {
  handleNavigation({ page: NavigationPage.MODELS });
}

async function createRouter(): Promise<void> {
  if (!canSave || saving) return;

  saving = true;
  error = '';

  try {
    const config: SemanticRouterConfigInfo = {
      name: name.trim(),
      description: description.trim() || undefined,
      listeners: [
        {
          address: listenerAddress.trim() || '0.0.0.0',
          port: listenerPort,
          timeout: parseTimeout(timeout),
        },
      ],
      routing: {
        keywords: [],
        decisions: [],
      },
    };

    await window.createSemanticRouter(config);
    handleNavigation({ page: NavigationPage.MODELS });
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    saving = false;
  }
}

function parseTimeout(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(\d+)\s*s?$/.exec(trimmed);
  if (match) return parseInt(match[1], 10);
  return undefined;
}
</script>

<FormPage title="Add Semantic Router">
  {#snippet content()}
    <div class="px-5 pb-5 min-w-full">
      <div class="bg-(--pd-content-card-bg) py-6">
        <div class="flex flex-col px-6 max-w-4xl mx-auto space-y-5">

          <!-- Page header -->
          <div class="mb-2">
            <span
              class="text-xs font-semibold uppercase tracking-widest text-(--pd-label-primary-text)
                bg-(--pd-label-primary-bg) px-2 py-0.5 rounded mb-2 inline-flex items-center gap-1.5">
              <Icon icon={faPlus} size="xs" />
              New Semantic Router
            </span>
            <h1 class="text-2xl font-bold text-(--pd-modal-text) mb-1">Configure a Semantic Router</h1>
            <p class="text-sm text-(--pd-content-card-text) opacity-70 max-w-2xl leading-relaxed">
              Define backend model pools, signal rules, and routing decisions. The router exposes a single
              <code class="text-(--pd-button-primary-bg) text-[13px]">/v1/chat/completions</code> endpoint your
              agents use — no code changes needed.
            </p>
          </div>

          <!-- Stepper -->
          <WizardStepper steps={WIZARD_STEPS} currentIndex={0} />

          <!-- Step content card -->
          <div class="rounded-xl border border-(--pd-content-card-border) bg-(--pd-content-card-inset-bg) p-6">
            <h2 class="text-lg font-semibold text-(--pd-modal-text) mb-1">Basic setup</h2>
            <p class="text-sm text-(--pd-content-card-text) opacity-60 mb-5">
              Give the router a name and configure the listener. Agents connect to the listener endpoint; they never
              talk to backends directly.
            </p>

            <div class="space-y-4">
              <!-- Name + Description row -->
              <div class="grid grid-cols-2 gap-3.5">
                <div>
                  <label for="router-name" class="block text-sm font-semibold text-(--pd-modal-text) mb-2">
                    Router name <span class="text-(--pd-input-field-error-text)">*</span>
                  </label>
                  <Input id="router-name" bind:value={name} placeholder="e.g. coding-router" aria-label="Router name" />
                  <p class="text-xs text-(--pd-content-card-text) opacity-50 mt-1.5">
                    Used as the identifier when selecting this router in workspace creation.
                  </p>
                </div>
                <div>
                  <label for="router-description" class="block text-sm font-semibold text-(--pd-modal-text) mb-2">
                    Description
                  </label>
                  <Input id="router-description" bind:value={description} placeholder="Short description of the routing strategy" aria-label="Description" />
                </div>
              </div>

              <!-- Address + Port row -->
              <div class="grid grid-cols-2 gap-3.5">
                <div>
                  <label for="listener-address" class="block text-sm font-semibold text-(--pd-modal-text) mb-2">
                    Listener address
                  </label>
                  <Input id="listener-address" bind:value={listenerAddress} placeholder="0.0.0.0" aria-label="Listener address" />
                  <p class="text-xs text-(--pd-content-card-text) opacity-50 mt-1.5">
                    Use <code class="text-(--pd-button-primary-bg)">host.containers.internal</code> when running
                    inside a container to reach host services.
                  </p>
                </div>
                <div>
                  <span class="block text-sm font-semibold text-(--pd-modal-text) mb-2">
                    Listener port
                  </span>
                  <NumberInput bind:value={listenerPort} minimum={1024} maximum={65535} type="integer" aria-label="Listener port" />
                  <p class="text-xs text-(--pd-content-card-text) opacity-50 mt-1.5">
                    Default: <strong>8899</strong>. Agents connect to
                    <code class="text-(--pd-button-primary-bg)">http://host:{listenerPort}/v1/chat/completions</code>.
                  </p>
                </div>
              </div>

              <!-- Timeout row -->
              <div class="max-w-[calc(50%-7px)]">
                <label for="router-timeout" class="block text-sm font-semibold text-(--pd-modal-text) mb-2">
                  Timeout
                </label>
                <Input id="router-timeout" bind:value={timeout} placeholder="300s" aria-label="Timeout" />
                <p class="text-xs text-(--pd-content-card-text) opacity-50 mt-1.5">
                  Maximum time before the request is cancelled.
                </p>
              </div>
            </div>
          </div>

          {#if error}
            <ErrorMessage error={error} />
          {/if}

          <!-- Footer actions -->
          <div class="flex items-center justify-between pt-4 border-t border-(--pd-content-card-border)">
            <span class="text-sm text-(--pd-content-card-text) opacity-70">
              Step 1 of {WIZARD_STEPS.length}
            </span>
            <div class="flex flex-wrap items-center justify-end gap-3">
              <Button onclick={cancel}>Cancel</Button>
              <Button disabled={!canSave || saving} onclick={createRouter}>
                {saving ? 'Creating...' : 'Next: Backend models'}
              </Button>
            </div>
          </div>

        </div>
      </div>
    </div>
  {/snippet}
</FormPage>
