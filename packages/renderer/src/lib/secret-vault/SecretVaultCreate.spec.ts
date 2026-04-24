/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';

import SecretVaultCreate from './SecretVaultCreate.svelte';

vi.mock(import('/@/navigation'));

beforeEach(() => {
  vi.resetAllMocks();
});

test('Expect form elements rendered correctly', () => {
  render(SecretVaultCreate);

  const headings = screen.getAllByText('Add Secret');
  expect(headings.length).toBeGreaterThanOrEqual(1);

  expect(screen.getByPlaceholderText('e.g. GitHub · docs repo')).toBeInTheDocument();
  expect(screen.getByText('API Token')).toBeInTheDocument();
  expect(screen.getByText('Infrastructure')).toBeInTheDocument();
  expect(screen.getByLabelText('Credential type')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Paste token or key')).toBeInTheDocument();
  expect(screen.getByLabelText('Expiration date')).toBeInTheDocument();
  expect(screen.getByLabelText('No expiry')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save Secret' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  expect(screen.getByText(/you can connect this credential from agent workspaces/i)).toBeInTheDocument();
});

test('Expect cancel navigates back to secret vault', async () => {
  const { handleNavigation } = await import('/@/navigation');

  render(SecretVaultCreate);

  const cancelButton = screen.getByRole('button', { name: 'Cancel' });
  await fireEvent.click(cancelButton);

  expect(handleNavigation).toHaveBeenCalledWith({ page: 'secret-vault' });
});
