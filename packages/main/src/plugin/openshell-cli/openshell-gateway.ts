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
import type { WriteStream } from 'node:fs';
import { closeSync, createWriteStream, openSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Disposable } from '@openkaiden/api';
import { inject, injectable, preDestroy } from 'inversify';
import Mustache from 'mustache';

import { CliToolRegistry } from '/@/plugin/cli-tool-registry.js';
import { Directories } from '/@/plugin/directories.js';
import { Emitter } from '/@/plugin/events/emitter.js';
import { OpenshellCli } from '/@/plugin/openshell-cli/openshell-cli.js';
import { NotificationRegistry } from '/@/plugin/tasks/notification-registry.js';
import { Exec } from '/@/plugin/util/exec.js';
import { isFreePort } from '/@/plugin/util/port.js';
import type { Event } from '/@api/event.js';
import {
  type CreateLocalGatewayOptions,
  GATEWAY_NAME_PATTERN,
  type OpenshellGatewayStartOptions,
} from '/@api/openshell-gateway-info.js';

import gatewayConfigTemplate from './openshell-gateway.toml.template?raw';

const DEFAULT_PORT = 17670;
const DEFAULT_BIND_ADDRESS = '127.0.0.1';
const HEALTH_CHECK_INTERVAL_MS = 1000;
const MAX_HEALTH_CHECK_ATTEMPTS = 30;
const STOP_TIMEOUT_MS = 5000;
const SUPERVISOR_IMAGE_BASE = 'ghcr.io/nvidia/openshell/supervisor';
const GATEWAY_LOG_FILENAME = 'gateway.log';
const DEFAULT_GATEWAY_NAME = 'kaiden-local';

type LocalComputeDriver = 'docker' | 'podman';

/**
 * Manages the `openshell-gateway` server binary lifecycle.
 *
 * On {@link init}, discovers existing gateways via the CLI. If a healthy
 * gateway is found it is selected. Otherwise, auto-starts a new local
 * gateway by spawning the `openshell-gateway` binary, waiting for it to
 * become healthy, and registering it with the CLI.
 */
@injectable()
export class OpenshellGateway implements Disposable {
  #gatewayProcess: ChildProcess | undefined;
  #gatewayLogStream: WriteStream | undefined;
  #port: number = DEFAULT_PORT;
  #bindAddress: string = DEFAULT_BIND_ADDRESS;

  private readonly _onDidGatewayStart = new Emitter<void>();
  readonly onDidGatewayStart: Event<void> = this._onDidGatewayStart.event;

  private readonly _onDidGatewayInitFailed = new Emitter<string>();
  readonly onDidGatewayInitFailed: Event<string> = this._onDidGatewayInitFailed.event;

  constructor(
    @inject(CliToolRegistry)
    private readonly cliToolRegistry: CliToolRegistry,
    @inject(OpenshellCli)
    private readonly openshellCli: OpenshellCli,
    @inject(Directories)
    private readonly directories: Directories,
    @inject(Exec)
    private readonly exec: Exec,
    @inject(NotificationRegistry)
    private readonly notificationRegistry: NotificationRegistry,
  ) {}

  async init(): Promise<void> {
    try {
      const gateways = await this.openshellCli.listGateways();
      const localGateways = gateways.filter(gw => gw.type === 'local' || this.isLocalEndpoint(gw.endpoint));
      if (localGateways.length > 0) {
        for (const gw of localGateways) {
          if (await this.isEndpointHealthy(gw.endpoint)) {
            if (!gw.active) {
              await this.openshellCli.selectGateway(gw.name);
            }
            console.log(`[openshell-gateway] gateway detected (${gw.endpoint}) and is healthy`);
            this._onDidGatewayStart.fire();
            return;
          }
        }
        console.warn('[openshell-gateway] local gateway(s) defined but none reachable');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[openshell-gateway] failed to discover gateways: ${message}`);
    }

    const binaryPath = this.getGatewayBinaryPath();
    if (!binaryPath) {
      console.warn('[openshell-gateway] no existing gateways and binary not registered, skipping auto-start');
      return;
    }

    if (await this.isEndpointHealthy()) {
      console.log('[openshell-gateway] found healthy gateway on default port, registering');
      await this.registerWithCli().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[openshell-gateway] failed to register with CLI: ${message}`);
      });
      this._onDidGatewayStart.fire();
      return;
    }

    console.log('[openshell-gateway] no existing gateways found, auto-starting local gateway');
    try {
      await this.start();
      this._onDidGatewayStart.fire();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[openshell-gateway] auto-start failed: ${message}`);
      this._onDidGatewayInitFailed.fire(message);
      this.notificationRegistry.addNotification({
        title: 'OpenShell Gateway failed to start',
        body: message,
        extensionId: 'core',
        type: 'error',
        highlight: true,
        silent: false,
      });
    }
  }

  private async isEndpointHealthy(endpoint?: string): Promise<boolean> {
    const target = endpoint ?? `http://${this.#bindAddress}:${this.#port}`;
    return this.openshellCli.checkEndpointStatus(target);
  }

  private isLocalEndpoint(endpoint: string): boolean {
    try {
      const url = new URL(endpoint);
      return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  getGatewayBinaryPath(): string | undefined {
    const tool = this.cliToolRegistry.getCliToolInfos().find(t => t.name === 'openshell-gateway');
    return tool?.path;
  }

  async createLocalGateway(options: CreateLocalGatewayOptions): Promise<void> {
    const name = options.name.trim();
    this.validateGatewayName(name, false);
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error('Port must be an integer between 1 and 65535');
    }
    const bindAddress = options.bindAddress.trim();
    if (bindAddress !== 'localhost' && isIP(bindAddress) === 0) {
      throw new Error('Bind address must be localhost or a valid IPv4 or IPv6 address');
    }
    const gateways = await this.openshellCli.listGateways();
    if (gateways.some(gateway => gateway.name === name)) {
      throw new Error(`A gateway named "${name}" is already registered`);
    }
    const endpointHost = isIP(bindAddress) === 6 ? `[${bindAddress}]` : bindAddress;
    const registeredPortInUse = gateways.some(gateway => {
      try {
        return new URL(gateway.endpoint).port === String(options.port);
      } catch {
        return false;
      }
    });
    if (registeredPortInUse) {
      throw new Error(`A gateway is already registered on port ${options.port}`);
    }
    await isFreePort(options.port);

    const binaryPath = this.getGatewayBinaryPath();
    if (!binaryPath) {
      throw new Error('openshell-gateway binary not registered in CLI tool registry');
    }
    const storageDirectory = this.getGatewayStorageDirectory(name);
    const config = await this.renderGatewayConfig(binaryPath, storageDirectory);
    const configPath = await this.writeGatewayConfig(binaryPath, storageDirectory, config, true, bindAddress);
    const logFd = openSync(join(storageDirectory, GATEWAY_LOG_FILENAME), 'w');
    let gatewayProcess: ChildProcess;
    try {
      gatewayProcess = spawn(
        binaryPath,
        [
          ...this.buildArgs(false, configPath, storageDirectory, options.port, bindAddress),
          '--tls-cert',
          join(storageDirectory, 'server', 'tls.crt'),
          '--tls-key',
          join(storageDirectory, 'server', 'tls.key'),
          '--tls-client-ca',
          join(storageDirectory, 'ca.crt'),
        ],
        {
          stdio: ['ignore', logFd, logFd],
          detached: true,
          env: { ...process.env, OPENSHELL_LOCAL_TLS_DIR: storageDirectory },
        },
      );
    } finally {
      closeSync(logFd);
    }

    let registered = false;
    try {
      await this.openshellCli.addGateway({
        endpoint: `https://${endpointHost}:${options.port}`,
        local: true,
        name,
      });
      registered = true;
      // `gateway add --local` copies the CLI's default local PKI into this registration.
      // Replace it with the certificates generated specifically for this gateway.
      await this.installGatewayClientCertificates(name, storageDirectory);
      await this.waitForIndependentGateway(gatewayProcess, name);
      gatewayProcess.unref();
    } catch (err: unknown) {
      gatewayProcess.kill('SIGTERM');
      if (registered) {
        await this.openshellCli.removeGateway(name).catch(() => undefined);
      }
      throw err;
    }
    this._onDidGatewayStart.fire();
  }

  async start(options?: OpenshellGatewayStartOptions): Promise<void> {
    if (this.#gatewayProcess) {
      console.log('[openshell-gateway] already running, skipping start');
      return;
    }

    const binaryPath = this.getGatewayBinaryPath();
    if (!binaryPath) {
      throw new Error('openshell-gateway binary not registered in CLI tool registry');
    }

    const previousPort = this.#port;
    const previousBindAddress = this.#bindAddress;

    if (options?.port !== undefined) {
      this.#port = options.port;
    }
    if (options?.bindAddress !== undefined) {
      this.#bindAddress = options.bindAddress;
    }

    const storageDirectory = this.getGatewayStorageDirectory(DEFAULT_GATEWAY_NAME);
    const configPath = await this.createGatewayConfig(binaryPath, options?.supervisorImage);
    const args = this.buildArgs(options?.disableTls ?? true, configPath, storageDirectory);
    console.log(`[openshell-gateway] starting: ${binaryPath} ${args.join(' ')}`);
    await this.initializeGatewayLog(storageDirectory);

    const gatewayProcess = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.#gatewayProcess = gatewayProcess;

    gatewayProcess.stdout?.on('data', (data: Buffer) => {
      this.#gatewayLogStream?.write(data);
    });

    const stderrChunks: string[] = [];
    gatewayProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      this.#gatewayLogStream?.write(data);
      stderrChunks.push(text);
    });

    gatewayProcess.on('exit', (code, signal) => {
      console.log(`[openshell-gateway] exited with code=${code ?? 'none'} signal=${signal ?? 'none'}`);
      if (this.#gatewayProcess === gatewayProcess) {
        this.#gatewayProcess = undefined;
      }
    });

    gatewayProcess.on('error', (err: Error) => {
      console.error(`[openshell-gateway] failed to start: ${err.message}`);
      if (this.#gatewayProcess === gatewayProcess) {
        this.#gatewayProcess = undefined;
      }
    });

    try {
      await this.waitForReady();
    } catch (err: unknown) {
      await this.stop().catch((stopErr: unknown) => {
        console.warn('[openshell-gateway] failed to stop after startup error:', stopErr);
      });
      this.#port = previousPort;
      this.#bindAddress = previousBindAddress;
      const stderrOutput = stderrChunks.join('\n').trim();
      const baseMessage = err instanceof Error ? err.message : String(err);
      throw new Error(stderrOutput ? `${baseMessage}: ${stderrOutput}` : baseMessage);
    }
    if (!options?.skipRegistration) {
      try {
        await this.registerWithCli();
      } catch (err: unknown) {
        await this.stop();
        this.#port = previousPort;
        this.#bindAddress = previousBindAddress;
        throw err;
      }
    }
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
    this.stop()
      .catch((err: unknown) => console.error('[openshell-gateway] failed to stop: ', err))
      .finally(() => this.closeGatewayLog());
    this._onDidGatewayStart.dispose();
    this._onDidGatewayInitFailed.dispose();
  }

  private async generateCerts(
    binaryPath: string,
    gatewayDir: string,
    isolate = false,
    serverSan?: string,
  ): Promise<void> {
    const args = [
      'generate-certs',
      '--server-san',
      '127.0.0.1',
      '--server-san',
      'localhost',
      '--server-san',
      'host.openshell.internal',
      '--output-dir',
      gatewayDir,
    ];
    if (serverSan && !['127.0.0.1', 'localhost', 'host.openshell.internal'].includes(serverSan)) {
      args.push('--server-san', serverSan);
    }
    if (!isolate) {
      await this.exec.exec(binaryPath, args);
      return;
    }
    const isolatedConfigDirectory = join(gatewayDir, 'xdg-config');
    await mkdir(isolatedConfigDirectory, { recursive: true });
    await this.exec.exec(binaryPath, args, { env: { XDG_CONFIG_HOME: isolatedConfigDirectory } });
  }

  private buildArgs(
    disableTls: boolean,
    configPath: string | undefined,
    storageDirectory: string,
    port = this.#port,
    bindAddress = this.#bindAddress,
  ): string[] {
    const args: string[] = [];
    if (configPath) {
      args.push('--config', configPath);
    }
    args.push('--port', String(port));
    args.push('--bind-address', bindAddress);
    if (disableTls) {
      args.push('--disable-tls');
    }
    args.push('--db-url', `sqlite:${join(storageDirectory, 'gateway.db')}?mode=rwc`);
    return args;
  }

  private async getGatewayVersion(binaryPath: string): Promise<string> {
    const result = await this.exec.exec(binaryPath, ['--version']);
    const output = result.stdout.trim();
    const token = output.split(' ').pop() ?? '';
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => p.length === 0 || !Number.isFinite(Number(p)))) {
      throw new Error(`Unable to parse version from: ${output}`);
    }
    return token;
  }

  private async renderGatewayConfig(
    binaryPath: string,
    storageDirectory: string,
    supervisorImage?: string,
  ): Promise<string> {
    let image = supervisorImage;
    if (!image) {
      try {
        const version = await this.getGatewayVersion(binaryPath);
        image = `${SUPERVISOR_IMAGE_BASE}:${version}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[openshell-gateway] unable to detect version for supervisor pinning: ${message}`);
      }
    }
    const driver = await this.detectLocalComputeDriver();
    return Mustache.render(gatewayConfigTemplate, {
      supervisorImage: image,
      gatewayDir: storageDirectory,
      q: '"',
      driver,
    });
  }

  private async createGatewayConfig(binaryPath: string, supervisorImage?: string): Promise<string | undefined> {
    try {
      const storageDirectory = this.getGatewayStorageDirectory(DEFAULT_GATEWAY_NAME);
      const config = await this.renderGatewayConfig(binaryPath, storageDirectory, supervisorImage);
      const configPath = await this.writeGatewayConfig(binaryPath, storageDirectory, config);
      console.log(`[openshell-gateway] generated local gateway config at ${configPath}`);
      return configPath;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[openshell-gateway] failed to generate gateway config: ${message}`);
      return undefined;
    }
  }

  private async detectLocalComputeDriver(): Promise<LocalComputeDriver | undefined> {
    try {
      const info = await this.openshellCli.getGatewayInfo();
      const driver = info.compute_drivers[0]?.capabilities.driver_name;
      return driver === 'podman' || driver === 'docker' ? driver : undefined;
    } catch {
      return undefined;
    }
  }

  private async waitForReady(): Promise<void> {
    const endpoint = `http://${this.#bindAddress}:${this.#port}`;
    console.log(`[openshell-gateway] waiting for server at ${endpoint}`);

    for (let attempt = 0; attempt < MAX_HEALTH_CHECK_ATTEMPTS; attempt++) {
      if (!this.isRunning()) {
        throw new Error('Gateway process exited before becoming ready');
      }

      if (await this.openshellCli.checkEndpointStatus(endpoint)) {
        console.log('[openshell-gateway] server is ready');
        return;
      }

      await new Promise<void>(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }

    throw new Error(`Gateway did not become ready within ${MAX_HEALTH_CHECK_ATTEMPTS}s`);
  }

  private async registerWithCli(): Promise<void> {
    const endpoint = `http://${this.#bindAddress}:${this.#port}`;
    const gateways = await this.openshellCli.listGateways();
    const existing = gateways.find(gw => gw.name === DEFAULT_GATEWAY_NAME);
    if (existing) {
      if (existing.endpoint === endpoint) {
        console.log(`[openshell-gateway] ${DEFAULT_GATEWAY_NAME} already registered at ${endpoint}`);
        return;
      }
      await this.openshellCli.removeGateway(DEFAULT_GATEWAY_NAME).catch(() => {});
    }
    await this.openshellCli.addGateway({ endpoint, local: true, name: DEFAULT_GATEWAY_NAME });
    console.log(`[openshell-gateway] registered with CLI as ${DEFAULT_GATEWAY_NAME} at ${endpoint}`);
  }

  private async initializeGatewayLog(storageDirectory: string): Promise<void> {
    if (this.#gatewayLogStream) {
      return;
    }

    const logPath = join(storageDirectory, GATEWAY_LOG_FILENAME);
    try {
      await mkdir(storageDirectory, { recursive: true });
      const stream = createWriteStream(logPath, { flags: 'w' });
      this.#gatewayLogStream = stream;
      stream.on('error', (err: Error) => {
        if (this.#gatewayLogStream === stream) {
          this.#gatewayLogStream = undefined;
        }
        console.error(`[openshell-gateway] unable to write log file ${logPath}: ${err.message}`);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[openshell-gateway] unable to open log file ${logPath}: ${message}`);
    }
  }

  private closeGatewayLog(): void {
    this.#gatewayLogStream?.end();
    this.#gatewayLogStream = undefined;
  }

  private validateGatewayName(name: string, allowDefault = true): void {
    if (!GATEWAY_NAME_PATTERN.test(name)) {
      throw new Error(
        'Gateway name must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, dashes, or underscores',
      );
    }
    if (!allowDefault && name === DEFAULT_GATEWAY_NAME) {
      throw new Error(`"${DEFAULT_GATEWAY_NAME}" is reserved for the gateway managed by Kaiden`);
    }
  }

  private getGatewayStorageDirectory(name: string): string {
    if (name === DEFAULT_GATEWAY_NAME) {
      return join(this.directories.getDataDirectory(), 'openshell-gateway');
    }
    return join(this.directories.getDataDirectory(), 'openshell-gateways', name);
  }

  private async writeGatewayConfig(
    binaryPath: string,
    storageDirectory: string,
    config: string,
    isolatePki = false,
    serverSan?: string,
  ): Promise<string> {
    const configPath = join(storageDirectory, 'gateway.toml');
    await mkdir(storageDirectory, { recursive: true });
    await this.generateCerts(binaryPath, storageDirectory, isolatePki, serverSan);
    await writeFile(configPath, config, 'utf-8');
    return configPath;
  }

  private async installGatewayClientCertificates(name: string, storageDirectory: string): Promise<void> {
    const configHome = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
    const mtlsDirectory = join(configHome, 'openshell', 'gateways', name, 'mtls');
    await mkdir(mtlsDirectory, { recursive: true });
    await Promise.all([
      copyFile(join(storageDirectory, 'ca.crt'), join(mtlsDirectory, 'ca.crt')),
      copyFile(join(storageDirectory, 'client', 'tls.crt'), join(mtlsDirectory, 'tls.crt')),
      copyFile(join(storageDirectory, 'client', 'tls.key'), join(mtlsDirectory, 'tls.key')),
    ]);
  }

  private async waitForIndependentGateway(gatewayProcess: ChildProcess, name: string): Promise<void> {
    let spawnError: Error | undefined;
    gatewayProcess.once('error', err => (spawnError = err));
    for (let attempt = 0; attempt < MAX_HEALTH_CHECK_ATTEMPTS; attempt++) {
      if (spawnError) {
        throw spawnError;
      }
      if (typeof gatewayProcess.exitCode === 'number') {
        throw new Error('Gateway process exited before becoming ready');
      }
      try {
        await this.openshellCli.getGatewayInfo(name);
        return;
      } catch {
        // The gateway may accept connections shortly after its process starts; retry until the timeout.
      }
      await new Promise<void>(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }
    throw new Error(`Gateway did not become ready within ${MAX_HEALTH_CHECK_ATTEMPTS}s`);
  }
}
