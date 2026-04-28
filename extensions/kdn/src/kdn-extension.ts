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

import { existsSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';

import type { CliTool, CliToolInstallationSource, Disposable, ExtensionContext } from '@openkaiden/api';
import * as extensionApi from '@openkaiden/api';

import { downloadKdn, getLatestVersion } from './kdn-download';

const DOWNLOAD_TIMEOUT_MS = 60_000;

export class KdnExtension {
  private downloadAbortController: AbortController | undefined;
  private deactivated = false;
  private cliTool: CliTool | undefined;
  private configDisposable: Disposable | undefined;

  constructor(private readonly extensionContext: ExtensionContext) {}

  async activate(): Promise<void> {
    const binDir = join(this.extensionContext.storagePath, 'bin');
    const binaryName = extensionApi.env.isWindows ? 'kdn.exe' : 'kdn';
    const localBinaryPath = join(binDir, binaryName);

    const { path: binaryPath, version, installationSource } = await this.resolveBinary();

    if (binaryPath) {
      this.registerCliTool(binaryPath, version, installationSource);
      return;
    }

    this.downloadAndRegister(localBinaryPath, binDir).catch((err: unknown) => {
      console.error('background kdn download failed', err);
    });
  }

  async deactivate(): Promise<void> {
    this.deactivated = true;
    this.downloadAbortController?.abort();
  }

  private registerCliTool(
    binaryPath: string,
    version: string | undefined,
    installationSource: CliToolInstallationSource,
  ): void {
    this.cliTool = extensionApi.cli.createCliTool({
      name: 'kdn',
      displayName: 'kdn',
      markdownDescription: 'Kaiden CLI for managing agent workspaces',
      images: {},
      version,
      path: binaryPath,
      installationSource,
    });
    this.extensionContext.subscriptions.push(this.cliTool);

    this.configDisposable = extensionApi.configuration.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('kdn.binary.path')) {
        await this.onCustomPathChanged();
      }
    });
    this.extensionContext.subscriptions.push(this.configDisposable);
  }

  private async downloadAndRegister(localBinaryPath: string, binDir: string): Promise<void> {
    await extensionApi.window.withProgress(
      { location: extensionApi.ProgressLocation.TASK_WIDGET, title: 'Downloading kdn CLI' },
      async (_progress, token) => {
        const abortController = new AbortController();
        this.downloadAbortController = abortController;
        const timeoutId = setTimeout(() => abortController.abort(), DOWNLOAD_TIMEOUT_MS);
        token.onCancellationRequested(() => abortController.abort());

        try {
          const latestVersion = await getLatestVersion(abortController.signal);
          await downloadKdn(latestVersion, process.platform, arch(), binDir, abortController.signal);
          if (this.deactivated) return;
          const version = await this.getVersion(localBinaryPath);
          if (version) {
            this.registerCliTool(localBinaryPath, version, 'extension');
          } else {
            throw new Error(`kdn binary downloaded to ${localBinaryPath} but failed to report a version`);
          }
        } finally {
          clearTimeout(timeoutId);
          this.downloadAbortController = undefined;
        }
      },
    );
  }

  private getCustomBinaryPath(): string | undefined {
    const value = extensionApi.configuration.getConfiguration('kdn').get<string>('binary.path');
    if (value) {
      return value;
    }
    return undefined;
  }

  private async onCustomPathChanged(): Promise<void> {
    if (!this.cliTool) return;

    const { path: binaryPath, version } = await this.resolveBinary();
    if (binaryPath && version) {
      this.cliTool.updateVersion({ version, path: binaryPath });
    }
  }

  private async resolveBinary(): Promise<{
    path: string | undefined;
    version: string | undefined;
    installationSource: CliToolInstallationSource;
  }> {
    const customPath = this.getCustomBinaryPath();
    if (customPath) {
      const version = await this.getVersion(customPath);
      if (version) {
        return { path: customPath, version, installationSource: 'external' };
      }
      console.warn(`kdn binary not found or invalid at custom path: ${customPath}`);
    }

    const binDir = join(this.extensionContext.storagePath, 'bin');
    const binaryName = extensionApi.env.isWindows ? 'kdn.exe' : 'kdn';
    const localBinaryPath = join(binDir, binaryName);

    if (existsSync(localBinaryPath)) {
      const version = await this.getVersion(localBinaryPath);
      if (version) {
        return { path: localBinaryPath, version, installationSource: 'extension' };
      }
    }

    const systemResult = await this.findOnPath();
    if (systemResult) {
      return { path: 'kdn', version: systemResult.version, installationSource: 'external' };
    }

    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const bundledBinaryPath = join(resourcesPath, 'kdn', binaryName);
      if (existsSync(bundledBinaryPath)) {
        const version = await this.getVersion(bundledBinaryPath);
        if (version) {
          return { path: bundledBinaryPath, version, installationSource: 'extension' };
        }
      }
    }

    return { path: undefined, version: undefined, installationSource: 'external' };
  }

  private parseVersion(output: string): string | undefined {
    const parts = output.trim().split(/\s+/);
    return parts[parts.length - 1] || undefined;
  }

  private async getVersion(binaryPath: string): Promise<string | undefined> {
    try {
      const result = await extensionApi.process.exec(binaryPath, ['version']);
      return this.parseVersion(result.stdout || result.stderr);
    } catch {
      return undefined;
    }
  }

  private async findOnPath(): Promise<{ version: string } | undefined> {
    try {
      const result = await extensionApi.process.exec('kdn', ['version']);
      const version = this.parseVersion(result.stdout || result.stderr);
      if (version) return { version };
    } catch {
      // not on PATH
    }
    return undefined;
  }
}
