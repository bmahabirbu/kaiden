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

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

import type { RunResult } from '@openkaiden/api';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CliToolRegistry } from '/@/plugin/cli-tool-registry.js';
import type { Proxy } from '/@/plugin/proxy.js';
import { Exec } from '/@/plugin/util/exec.js';
import type { CliToolInfo } from '/@api/cli-tool-info.js';

import { OpenshellGateway } from './openshell-gateway.js';

vi.mock(import('node:child_process'));
vi.mock(import('node:fs'));
vi.mock(import('node:fs/promises'));
vi.mock(import('/@/plugin/util/exec.js'));

const { spawn } = await import('node:child_process');
const { writeFile, mkdir } = await import('node:fs/promises');

const GATEWAY_BINARY = '/usr/local/bin/openshell-gateway';
const CLI_BINARY = '/usr/local/bin/openshell';

function createMockChildProcess(): ChildProcess & { _stdout: EventEmitter; _stderr: EventEmitter } {
  const proc = new EventEmitter() as ChildProcess & { _stdout: EventEmitter; _stderr: EventEmitter };
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  Object.defineProperty(proc, 'stdout', { get: (): EventEmitter => proc._stdout });
  Object.defineProperty(proc, 'stderr', { get: (): EventEmitter => proc._stderr });
  proc.kill = vi.fn().mockReturnValue(true);
  return proc;
}

function mockExecResult(stdout = ''): RunResult {
  return { command: CLI_BINARY, stdout, stderr: '' };
}

let gateway: OpenshellGateway;

const exec = new Exec({} as Proxy);
const cliToolRegistry = {
  getCliToolInfos: vi.fn(),
} as unknown as CliToolRegistry;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cliToolRegistry.getCliToolInfos).mockReturnValue([
    { name: 'openshell-gateway', path: GATEWAY_BINARY },
    { name: 'openshell', path: CLI_BINARY },
  ] as unknown as CliToolInfo[]);
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
  gateway = new OpenshellGateway(exec, cliToolRegistry);
});

describe('init', () => {
  test('bootstraps TLS and starts gateway when certs do not exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    // generate-certs succeeds, then health check fails (not running), then waitForReady succeeds, then register succeeds
    vi.mocked(exec.exec)
      .mockResolvedValueOnce(mockExecResult(''))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(mockExecResult(''));

    await gateway.init();

    expect(exec.exec).toHaveBeenCalledWith(
      GATEWAY_BINARY,
      expect.arrayContaining(['generate-certs', '--output-dir', expect.stringContaining('tls')]),
    );
    expect(spawn).toHaveBeenCalled();
  });

  test('skips TLS bootstrap when certs already exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(true);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockRejectedValueOnce(new Error('not healthy')).mockResolvedValue(mockExecResult(''));

    await gateway.init();

    expect(exec.exec).not.toHaveBeenCalledWith(GATEWAY_BINARY, expect.arrayContaining(['generate-certs']));
  });

  test('skips start when gateway is already healthy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult(''));

    await gateway.init();

    expect(spawn).not.toHaveBeenCalled();
  });

  test('skips when gateway binary is not registered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(cliToolRegistry.getCliToolInfos).mockReturnValue([
      { name: 'openshell', path: CLI_BINARY },
    ] as unknown as CliToolInfo[]);

    await gateway.init();

    expect(spawn).not.toHaveBeenCalled();
  });

  test('returns gracefully when TLS bootstrap fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(exec.exec).mockRejectedValue(new Error('generate-certs failed'));

    await gateway.init();

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('getGatewayBinaryPath', () => {
  test('returns path from CLI tool registry', () => {
    expect(gateway.getGatewayBinaryPath()).toBe(GATEWAY_BINARY);
  });

  test('returns undefined when openshell-gateway is not registered', () => {
    vi.mocked(cliToolRegistry.getCliToolInfos).mockReturnValue([
      { name: 'openshell', path: CLI_BINARY },
    ] as unknown as CliToolInfo[]);
    expect(gateway.getGatewayBinaryPath()).toBeUndefined();
  });
});

describe('start', () => {
  test('spawns gateway with --config and TLS env', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult('connected'));

    await gateway.start();

    expect(spawn).toHaveBeenCalledWith(
      GATEWAY_BINARY,
      ['--config', expect.stringContaining('gateway.toml')],
      expect.objectContaining({
        detached: false,
        env: expect.objectContaining({
          OPENSHELL_LOCAL_TLS_DIR: expect.stringContaining('tls'),
        }),
      }),
    );
  });

  test('does not pass --disable-tls', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult('connected'));

    await gateway.start();

    const spawnArgs = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(spawnArgs).not.toContain('--disable-tls');
  });

  test('writes gateway config with VM driver', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult('connected'));

    await gateway.start();

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('gateway.toml'),
      expect.stringContaining('compute_drivers = ["vm"]'),
    );
  });

  test('skips writing config when it already exists', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(true);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult('connected'));

    await gateway.start();

    expect(writeFile).not.toHaveBeenCalled();
  });

  test('skips if already running', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult('connected'));

    await gateway.start();
    await gateway.start();

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('throws when gateway binary is not registered', async () => {
    vi.mocked(cliToolRegistry.getCliToolInfos).mockReturnValue([
      { name: 'openshell', path: CLI_BINARY },
    ] as unknown as CliToolInfo[]);

    await expect(gateway.start()).rejects.toThrow('openshell-gateway binary not registered');
  });

  test('health checks use https without --gateway-insecure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult(''));

    await gateway.start();

    expect(exec.exec).toHaveBeenCalledWith(CLI_BINARY, ['status', '--gateway-endpoint', 'https://127.0.0.1:17670']);
    expect(exec.exec).not.toHaveBeenCalledWith(CLI_BINARY, expect.arrayContaining(['--gateway-insecure']));
  });

  test('registers gateway as kaiden over https', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult(''));

    await gateway.start();

    expect(exec.exec).toHaveBeenCalledWith(CLI_BINARY, [
      'gateway',
      'add',
      'https://127.0.0.1:17670',
      '--local',
      '--name',
      'kaiden',
    ]);
  });

  test('stops the spawned process when waitForReady fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockRejectedValue(new Error('connection refused'));

    let caughtError: unknown;
    const startPromise = gateway.start().catch((err: unknown) => {
      caughtError = err;
    });

    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    proc.emit('exit', 1, undefined);
    await vi.advanceTimersByTimeAsync(5000);
    await startPromise;

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain('Gateway did not become ready');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    vi.useRealTimers();
  });
});

describe('stop', () => {
  test('sends SIGTERM to running process', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult(''));

    await gateway.start();

    const stopPromise = gateway.stop();
    proc.emit('exit', 0, undefined);
    await stopPromise;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('is a no-op when not running', async () => {
    await gateway.stop();
  });
});

describe('isRunning', () => {
  test('returns false when no process is spawned', () => {
    expect(gateway.isRunning()).toBe(false);
  });

  test('returns true when process is running', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult(''));

    await gateway.start();

    expect(gateway.isRunning()).toBe(true);
  });
});

describe('dispose', () => {
  test('stops the gateway process', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc);
    vi.mocked(exec.exec).mockResolvedValue(mockExecResult(''));

    await gateway.start();

    gateway.dispose();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
