<script lang="ts">
import { faKey, faServer, faShieldHalved } from '@fortawesome/free-solid-svg-icons';
import { Button, Checkbox, Dropdown, ErrorMessage, Input } from '@podman-desktop/ui-svelte';
import { Icon } from '@podman-desktop/ui-svelte/icons';

import { Textarea } from '/@/lib/chat/components/ui/textarea';
import CardSelector from '/@/lib/ui/CardSelector.svelte';
import FormPage from '/@/lib/ui/FormPage.svelte';
import PasswordInput from '/@/lib/ui/PasswordInput.svelte';
import { handleNavigation } from '/@/navigation';
import { NavigationPage } from '/@api/navigation-page';

const categoryOptions = [
  {
    title: 'API Token',
    badge: 'API',
    value: 'api',
    icon: faKey,
    description: 'API keys, access tokens, and service credentials',
  },
  {
    title: 'Infrastructure',
    badge: 'Infra',
    value: 'infra',
    icon: faServer,
    description: 'Cluster tokens, platform keys, and infrastructure secrets',
  },
];

const credentialTypes = [
  { value: 'pat', label: 'Personal access token (PAT)' },
  { value: 'oauth', label: 'OAuth / refresh token' },
  { value: 'bot', label: 'Bot token' },
  { value: 'project', label: 'Fine-grained / project token' },
  { value: 'apikey', label: 'Generic API key' },
  { value: 'cluster', label: 'Cluster or platform token' },
  { value: 'service', label: 'Service account' },
  { value: 'other', label: 'Other' },
];

let name = $state('');
let category = $state('api');
let type = $state('pat');
let secret = $state('');
let description = $state('');
// TODO: backend not wired yet — using $derived(noExpiry ? '' : expiration) triggers no-unused-vars lint.
// When the IPC save call is implemented, rename this to expirationInput and add: let expiration = $derived(noExpiry ? '' : expirationInput);
let expiration = $state('');
let noExpiry = $state(false);
let saving = $state(false);
let error = $state('');

function cancel(): void {
  handleNavigation({ page: NavigationPage.SECRET_VAULT });
}

async function saveSecret(): Promise<void> {
  if (!name.trim() || !secret.trim()) return;

  saving = true;
  error = '';
  try {
    // TODO: send { name, category, type, secret, description, expiration } via IPC to SafeStorageRegistry
    handleNavigation({ page: NavigationPage.SECRET_VAULT });
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    saving = false;
  }
}
</script>

<FormPage title="Add Secret">
  {#snippet content()}
    <div class="px-5 pb-5 min-w-full">
      <div class="bg-[var(--pd-content-card-bg)] py-6">
        <div class="flex flex-col px-6 max-w-4xl mx-auto space-y-5">

          <div>
            <h1 class="text-2xl font-bold text-[var(--pd-modal-text)]">Add Secret</h1>
            <p class="text-sm text-[var(--pd-content-card-text)] opacity-70 mt-2">
              Store API tokens, OAuth secrets, and infrastructure keys in one place.
              Values are encrypted and only exposed to agents and flows you attach them to.
            </p>
          </div>

          <!-- Info callout -->
          <div class="flex gap-3 p-4 rounded-lg border border-[var(--pd-content-card-border)] bg-[var(--pd-content-card-inset-bg)]">
            <div class="flex-shrink-0 mt-0.5 text-[var(--pd-content-card-text)]">
              <Icon icon={faShieldHalved} />
            </div>
            <p class="text-sm text-[var(--pd-content-card-text)] opacity-80 leading-relaxed">
              After saving, you can connect this credential from agent workspaces, MCP servers, and Settings integrations.
              You won't be able to read the full secret back — only rotate or replace it.
            </p>
          </div>

          <!-- Form -->
          <section class="rounded-lg border border-[var(--pd-content-card-border)] bg-[var(--pd-content-card-inset-bg)] p-6 space-y-5">

            <!-- Display name -->
            <div>
              <span class="block text-sm font-semibold text-[var(--pd-modal-text)] mb-2">Display name</span>
              <Input bind:value={name} placeholder="e.g. GitHub · docs repo" aria-label="Display name" />
            </div>

            <!-- Category -->
            <CardSelector
              label="Category"
              options={categoryOptions}
              bind:selected={category}
            />

            <!-- Credential type -->
            <div>
              <span class="block text-sm font-semibold text-[var(--pd-modal-text)] mb-2">Credential type</span>
              <Dropdown
                name="credentialType"
                bind:value={type}
                ariaLabel="Credential type"
                options={credentialTypes}
              />
            </div>

            <!-- Secret value -->
            <div>
              <span class="block text-sm font-semibold text-[var(--pd-modal-text)] mb-2">Secret value</span>
              <PasswordInput
                bind:password={secret}
                placeholder="Paste token or key"
                aria-label="Secret value"
              />
            </div>

            <!-- Description -->
            <div>
              <span class="block text-sm font-semibold text-[var(--pd-modal-text)] mb-2">
                Description
                <span class="font-normal text-[var(--pd-content-card-text)] opacity-60">(optional)</span>
              </span>
              <Textarea
                bind:value={description}
                placeholder="Where it's used, scopes, or rotation notes"
                rows={3}
                class="bg-muted min-h-[24px] resize-none rounded-lg !text-sm dark:border-zinc-700"
              />
            </div>

            <!-- Expiration -->
            <div>
              <span class="block text-sm font-semibold text-[var(--pd-modal-text)] mb-2">
                Expiration
                <span class="font-normal text-[var(--pd-content-card-text)] opacity-60">(optional)</span>
              </span>
              <div class="flex items-center gap-4">
                <input
                  type="date"
                  bind:value={expiration}
                  disabled={noExpiry}
                  class="max-w-[280px] p-2 rounded-lg text-sm outline-hidden
                    bg-[var(--pd-input-field-bg)] text-[var(--pd-input-field-text)]
                    border border-[var(--pd-input-field-stroke)]
                    hover:border-[var(--pd-input-field-hover-stroke)]
                    focus:border-[var(--pd-input-field-focused-stroke)]
                    disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Expiration date"
                />
                <Checkbox bind:checked={noExpiry} title="No expiry" />
              </div>
            </div>
          </section>

          {#if error}
            <ErrorMessage error={error} />
          {/if}

          <!-- Footer actions -->
          <div class="flex items-center justify-end gap-3 pt-4 border-t border-[var(--pd-content-card-border)]">
            <Button onclick={cancel}>Cancel</Button>
            <Button disabled={!name.trim() || !secret.trim() || saving} onclick={saveSecret}>
              {saving ? 'Saving...' : 'Save Secret'}
            </Button>
          </div>

        </div>
      </div>
    </div>
  {/snippet}
</FormPage>
