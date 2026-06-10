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

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, expect, test, vi } from 'vitest';

import type { SemanticRouterConfigInfo } from '/@api/semantic-router-info';

import SemanticRouterCreate from './SemanticRouterCreate.svelte';

vi.mock(import('/@/navigation'));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(window.createSemanticRouter).mockResolvedValue({
    name: 'test-router',
    listeners: [{ address: '0.0.0.0', port: 8899 }],
    routing: { keywords: [], decisions: [] },
  });
});

test('renders the form title', () => {
  render(SemanticRouterCreate);

  expect(screen.getByText('Configure a Semantic Router')).toBeInTheDocument();
});

test('renders all form fields', () => {
  render(SemanticRouterCreate);

  expect(screen.getByLabelText('Router name')).toBeInTheDocument();
  expect(screen.getByLabelText('Description')).toBeInTheDocument();
  expect(screen.getByLabelText('Listener address')).toBeInTheDocument();
  expect(screen.getByLabelText('Listener port')).toBeInTheDocument();
  expect(screen.getByLabelText('Timeout')).toBeInTheDocument();
});

test('create button is disabled when name is empty', () => {
  render(SemanticRouterCreate);

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  expect(createBtn).toBeDisabled();
});

test('create button is enabled when name is provided', async () => {
  render(SemanticRouterCreate);

  const nameInput = screen.getByLabelText('Router name');
  await fireEvent.input(nameInput, { target: { value: 'my-router' } });

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  expect(createBtn).toBeEnabled();
});

test('calls createSemanticRouter on submit', async () => {
  render(SemanticRouterCreate);

  const nameInput = screen.getByLabelText('Router name');
  await fireEvent.input(nameInput, { target: { value: 'my-router' } });

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  await fireEvent.click(createBtn);

  await waitFor(() => {
    expect(window.createSemanticRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-router',
        listeners: expect.arrayContaining([expect.objectContaining({ address: '0.0.0.0', port: 8899 })]),
        routing: { keywords: [], decisions: [] },
      }),
    );
  });
});

test('navigates to models page after successful creation', async () => {
  render(SemanticRouterCreate);

  const nameInput = screen.getByLabelText('Router name');
  await fireEvent.input(nameInput, { target: { value: 'my-router' } });

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  await fireEvent.click(createBtn);

  const { handleNavigation } = await import('/@/navigation');
  await waitFor(() => {
    expect(handleNavigation).toHaveBeenCalledWith({ page: 'models' });
  });
});

test('shows error message on creation failure', async () => {
  vi.mocked(window.createSemanticRouter).mockRejectedValue(new Error('Router already exists'));

  render(SemanticRouterCreate);

  const nameInput = screen.getByLabelText('Router name');
  await fireEvent.input(nameInput, { target: { value: 'my-router' } });

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  await fireEvent.click(createBtn);

  await waitFor(() => {
    expect(screen.getByText('Router already exists')).toBeInTheDocument();
  });
});

test('navigates to models page on cancel', async () => {
  render(SemanticRouterCreate);

  const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
  await fireEvent.click(cancelBtn);

  const { handleNavigation } = await import('/@/navigation');
  expect(handleNavigation).toHaveBeenCalledWith({ page: 'models' });
});

test('passes description when provided', async () => {
  render(SemanticRouterCreate);

  const nameInput = screen.getByLabelText('Router name');
  await fireEvent.input(nameInput, { target: { value: 'my-router' } });

  const descInput = screen.getByLabelText('Description');
  await fireEvent.input(descInput, { target: { value: 'Routes coding tasks' } });

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  await fireEvent.click(createBtn);

  await waitFor(() => {
    expect(window.createSemanticRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Routes coding tasks',
      }),
    );
  });
});

test('parses timeout value with seconds suffix', async () => {
  render(SemanticRouterCreate);

  const nameInput = screen.getByLabelText('Router name');
  await fireEvent.input(nameInput, { target: { value: 'my-router' } });

  const timeoutInput = screen.getByLabelText('Timeout');
  await fireEvent.input(timeoutInput, { target: { value: '600s' } });

  const createBtn = screen.getByRole('button', { name: 'Next: Backend models' });
  await fireEvent.click(createBtn);

  await waitFor(() => {
    const call = vi.mocked(window.createSemanticRouter).mock.calls[0][0] as SemanticRouterConfigInfo;
    expect(call.listeners[0].timeout).toBe(600);
  });
});
