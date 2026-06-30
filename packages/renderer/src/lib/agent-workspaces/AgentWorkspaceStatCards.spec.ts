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

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import type { SandboxInfoWithGateway } from '/@/stores/openshell-sandboxes';

import AgentWorkspaceStatCards from './AgentWorkspaceStatCards.svelte';

function makeSandbox(overrides: Partial<SandboxInfoWithGateway> = {}): SandboxInfoWithGateway {
  return {
    id: 'sb-1',
    name: 'test',
    gatewayName: 'kaiden',
    phase: 'Unknown',
    ...overrides,
  };
}

test('should display count of unique configured agents', () => {
  const sandboxes: SandboxInfoWithGateway[] = [
    makeSandbox({ id: 'sb-1', labels: { 'ai.openkaiden.kaiden.agent': 'coder-v1' } }),
    makeSandbox({ id: 'sb-2', labels: { 'ai.openkaiden.kaiden.agent': 'coder-v1' } }),
    makeSandbox({ id: 'sb-3', labels: { 'ai.openkaiden.kaiden.agent': 'reviewer-v2' } }),
    makeSandbox({ id: 'sb-4' }),
  ];

  render(AgentWorkspaceStatCards, { sandboxes });

  const agentCard = screen.getByText('Configured Agents').parentElement!;
  expect(agentCard).toHaveTextContent('2');
});

test('should display 0 configured agents when no labels present', () => {
  render(AgentWorkspaceStatCards, { sandboxes: [makeSandbox()] });

  const agentCard = screen.getByText('Configured Agents').parentElement!;
  expect(agentCard).toHaveTextContent('0');
});
