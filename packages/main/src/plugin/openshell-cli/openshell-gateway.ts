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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Disposable } from '@openkaiden/api';
import { inject, injectable, preDestroy } from 'inversify';

import { CliToolRegistry } from '/@/plugin/cli-tool-registry.js';
import { Exec } from '/@/plugin/util/exec.js';

const DEFAULT_PORT = 17670;
const DEFAULT_BIND_ADDRESS = '127.0.0.1';
const HEALTH_CHECK_INTERVAL_MS = 1000;
const MAX_HEALTH_CHECK_ATTEMPTS = 30;
const STOP_TIMEOUT_MS = 5000;
const GATEWAY_NAME = 'kaiden';

const GATEWAY_CONFIG = `[openshell]
version = 1

[openshell.gateway]
bind_address = "${DEFAULT_BIND_ADDRESS}:${DEFAULT_PORT}"
compute_drivers = ["vm"]
`;

@injectable()
export class OpenshellGateway implements Disposable {
  #gatewayProcess: ChildProcess | undefined;
  #tlsDir: string;
  #configDir: string;

  constructor(
    @inject(Exec)
    private readonly exec: Exec,
    @inject(CliToolRegistry)
    private readonly cliToolRegistry: CliToolRegistry,
  ) {
    const home = homedir();
    this.#tlsDir = join(home, '.local', 'state', 'openshell', 'tls');
    this.#configDir = join(home, '.local', 'state', 'openshell', 'config');
  }

  async init(): Promise<void> {
    const gatewayBinaryPath = this.getGatewayBinaryPath();
    if (!gatewayBinaryPath) {
      console.warn('[openshell-gateway] gateway binary not registered, skipping');
      return;
    }

    try {
      await this.bootstrapTls(gatewayBinaryPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[openshell-gateway] TLS bootstrap failed: ${message}`);
      return;
    }

    if (await this.isEndpointHealthy()) {
      console.log('[openshell-gateway] gateway is already healthy');
      return;
    }

    console.log('[openshell-gateway] starting local gateway with VM driver');
    await this.start();
  }

  private async bootstrapTls(gatewayBinaryPath: string): Promise<void> {
    if (this.isTlsBootstrapped()) {
      console.log('[openshell-gateway] TLS already bootstrapped');
      return;
    }

    console.log('[openshell-gateway] bootstrapping TLS certificates');
    await this.exec.exec(gatewayBinaryPath, [
      'generate-certs',
      '--output-dir',
      this.#tlsDir,
      '--server-san',
      'host.openshell.internal',
    ]);
    console.log(`[openshell-gateway] TLS certificates generated in ${this.#tlsDir}`);
  }

  private isTlsBootstrapped(): boolean {
    return (
      existsSync(join(this.#tlsDir, 'ca.crt')) &&
      existsSync(join(this.#tlsDir, 'server', 'tls.crt')) &&
      existsSync(join(this.#tlsDir, 'server', 'tls.key')) &&
      existsSync(join(this.#tlsDir, 'client', 'tls.crt')) &&
      existsSync(join(this.#tlsDir, 'client', 'tls.key')) &&
      existsSync(join(this.#tlsDir, 'jwt', 'signing.pem')) &&
      existsSync(join(this.#tlsDir, 'jwt', 'public.pem'))
    );
  }

  private async isEndpointHealthy(): Promise<boolean> {
    const cliPath = this.getCliPath();
    try {
      await this.exec.exec(cliPath, [
        'status',
        '--gateway-endpoint',
        `https://${DEFAULT_BIND_ADDRESS}:${DEFAULT_PORT}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  getGatewayBinaryPath(): string | undefined {
    const tool = this.cliToolRegistry.getCliToolInfos().find(t => t.name === 'openshell-gateway');
    return tool?.path;
  }

  private getCliPath(): string {
    const tool = this.cliToolRegistry.getCliToolInfos().find(t => t.name === 'openshell');
    return tool?.path ?? 'openshell';
  }

  async start(): Promise<void> {
    if (this.#gatewayProcess) {
      console.log('[openshell-gateway] already running, skipping start');
      return;
    }

    const binaryPath = this.getGatewayBinaryPath();
    if (!binaryPath) {
      throw new Error('openshell-gateway binary not registered in CLI tool registry');
    }

    await this.writeGatewayConfig();

    const configPath = join(this.#configDir, 'gateway.toml');
    const args = ['--config', configPath];
    console.log(`[openshell-gateway] starting: ${binaryPath} ${args.join(' ')}`);

    this.#gatewayProcess = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        OPENSHELL_LOCAL_TLS_DIR: this.#tlsDir,
      },
    });

    this.#gatewayProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[openshell-gateway] ${data.toString().trimEnd()}`);
    });

    this.#gatewayProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[openshell-gateway] ${data.toString().trimEnd()}`);
    });

    this.#gatewayProcess.on('exit', (code, signal) => {
      console.log(`[openshell-gateway] exited with code=${code ?? 'none'} signal=${signal ?? 'none'}`);
      this.#gatewayProcess = undefined;
    });

    this.#gatewayProcess.on('error', (err: Error) => {
      console.error(`[openshell-gateway] failed to start: ${err.message}`);
      this.#gatewayProcess = undefined;
    });

    try {
      await this.waitForReady();
    } catch (err: unknown) {
      await this.stop().catch((stopErr: unknown) => {
        console.warn('[openshell-gateway] failed to stop after startup error:', stopErr);
      });
      throw err;
    }
    await this.registerWithCli();
  }

  async stop(): Promise<void> {
    const proc = this.#gatewayProcess;
    if (!proc) {
      return;
    }

    console.log('[openshell-gateway] stopping');
    proc.kill('SIGTERM');

    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        if (typeof proc.exitCode !== 'number') {
          console.warn('[openshell-gateway] did not exit after SIGTERM, sending SIGKILL');
          proc.kill('SIGKILL');
        }
        resolve();
      }, STOP_TIMEOUT_MS);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.#gatewayProcess = undefined;
  }

  isRunning(): boolean {
    return this.#gatewayProcess !== undefined && typeof this.#gatewayProcess.exitCode !== 'number';
  }

  @preDestroy()
  dispose(): void {
    this.stop().catch((err: unknown) => console.error('[openshell-gateway] failed to stop: ', err));
  }

  private async writeGatewayConfig(): Promise<void> {
    const configPath = join(this.#configDir, 'gateway.toml');
    if (existsSync(configPath)) {
      return;
    }
    await mkdir(this.#configDir, { recursive: true });
    await writeFile(configPath, GATEWAY_CONFIG);
    console.log(`[openshell-gateway] gateway config written to ${configPath}`);
  }

  private async waitForReady(): Promise<void> {
    const endpoint = `https://${DEFAULT_BIND_ADDRESS}:${DEFAULT_PORT}`;
    console.log(`[openshell-gateway] waiting for server at ${endpoint}`);

    const cliPath = this.getCliPath();
    for (let attempt = 0; attempt < MAX_HEALTH_CHECK_ATTEMPTS; attempt++) {
      if (!this.isRunning()) {
        throw new Error('Gateway process exited before becoming ready');
      }

      try {
        await this.exec.exec(cliPath, ['status', '--gateway-endpoint', endpoint]);
        console.log('[openshell-gateway] server is ready');
        return;
      } catch {
        // not ready yet
      }

      await new Promise<void>(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }

    throw new Error(`Gateway did not become ready within ${MAX_HEALTH_CHECK_ATTEMPTS}s`);
  }

  private async registerWithCli(): Promise<void> {
    const endpoint = `https://${DEFAULT_BIND_ADDRESS}:${DEFAULT_PORT}`;
    const cliPath = this.getCliPath();
    try {
      await this.exec.exec(cliPath, ['gateway', 'add', endpoint, '--local', '--name', GATEWAY_NAME]);
      console.log(`[openshell-gateway] registered with CLI as ${GATEWAY_NAME} at ${endpoint}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[openshell-gateway] failed to register with CLI: ${message}`);
    }
  }
}
