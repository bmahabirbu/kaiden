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
 **********************************************************************/

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { beforeEach, expect, test, vi } from 'vitest';

import { addHypervisorEntitlement, ensureHypervisorEntitlement } from './openshell-entitlements';

vi.mock(import('node:child_process'));
vi.mock(import('node:os'));

const execFileAsync = vi.mocked(promisify(execFile));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(platform).mockReturnValue('darwin');
  execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
});

test('adds the hypervisor entitlement with an ad hoc signature on macOS', async () => {
  const entitlements = resolve(__dirname, '..', 'resources', 'entitlements.openshell-driver-vm.plist');

  await addHypervisorEntitlement('/binary path/openshell-driver-vm');

  expect(execFileAsync).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--entitlements',
    entitlements,
    '/binary path/openshell-driver-vm',
  ]);
  expect(await readFile(entitlements, 'utf-8')).toMatch(/<key>com\.apple\.security\.hypervisor<\/key>\s*<true\/>/);
});

test.each(['linux', 'win32'] as const)('skips codesign when downloading macOS binaries on %s', async host => {
  vi.mocked(platform).mockReturnValue(host);

  await addHypervisorEntitlement('/binary/openshell-driver-vm');

  expect(execFileAsync).not.toHaveBeenCalled();
});

test('propagates codesign failures', async () => {
  execFileAsync.mockRejectedValue(new Error('codesign failed'));

  await expect(addHypervisorEntitlement('/binary/openshell-driver-vm')).rejects.toThrow('codesign failed');
});

test('keeps an existing hypervisor entitlement without re-signing', async () => {
  execFileAsync.mockResolvedValue({ stdout: '<key>com.apple.security.hypervisor</key><true/>', stderr: '' });

  await ensureHypervisorEntitlement('/binary/openshell-driver-vm');

  expect(execFileAsync).toHaveBeenCalledExactlyOnceWith('/usr/bin/codesign', [
    '--display',
    '--entitlements',
    '-',
    '--xml',
    '/binary/openshell-driver-vm',
  ]);
});

test.each([
  '',
  '<key>com.apple.security.hypervisor</key><false/>',
])('repairs a missing or disabled hypervisor entitlement: %s', async stdout => {
  execFileAsync.mockResolvedValueOnce({ stdout, stderr: '' });

  await ensureHypervisorEntitlement('/binary/openshell-driver-vm');

  expect(execFileAsync).toHaveBeenCalledTimes(2);
  expect(execFileAsync).toHaveBeenLastCalledWith(
    '/usr/bin/codesign',
    expect.arrayContaining(['--sign', '-', '--entitlements']),
  );
});

test.each(['linux', 'win32'] as const)('skips entitlement inspection on %s', async host => {
  vi.mocked(platform).mockReturnValue(host);
  await ensureHypervisorEntitlement('/binary/openshell-driver-vm');
  expect(execFileAsync).not.toHaveBeenCalled();
});

test('propagates entitlement inspection failures', async () => {
  execFileAsync.mockRejectedValue(new Error('inspection failed'));
  await expect(ensureHypervisorEntitlement('/binary/openshell-driver-vm')).rejects.toThrow('inspection failed');
});
