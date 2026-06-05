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

import { join } from 'node:path';

import type { CliToolInstaller, Logger } from '@openkaiden/api';
import * as extensionApi from '@openkaiden/api';

import { downloadOpenshellBinaries, getRelease } from './openshell-download';

export class OpenshellInstaller implements CliToolInstaller {
  private selectedVersion: string | undefined;
  readonly #openshellVersion: string;
  readonly #storagePath: string;

  constructor(openshellVersion: string, storagePath: string) {
    this.#openshellVersion = openshellVersion;
    this.#storagePath = storagePath;
  }

  async selectVersion(latest?: boolean): Promise<string> {
    if (latest || !this.selectedVersion) {
      this.selectedVersion = await this.fetchPinnedVersion();
    }
    return this.selectedVersion;
  }

  async doInstall(logger: Logger): Promise<void> {
    if (!extensionApi.env.isMac && !extensionApi.env.isLinux) {
      throw new Error('OpenShell install is not supported on this platform');
    }

    const version = this.selectedVersion ?? this.#openshellVersion;
    const platform = extensionApi.env.isMac ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const binDir = join(this.#storagePath, 'bin');

    logger.log(`Installing OpenShell ${version} for ${platform}/${arch}...`);

    try {
      const release = await getRelease(version);
      await downloadOpenshellBinaries(release.version, platform, arch, binDir, release.digests);
      logger.log('OpenShell installation completed successfully');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`OpenShell installation failed: ${message}`);
      throw error;
    }
  }

  async doUninstall(logger: Logger): Promise<void> {
    logger.log('Uninstalling OpenShell...');

    try {
      if (extensionApi.env.isMac) {
        await extensionApi.process.exec('brew', ['uninstall', 'openshell'], { logger });
      } else if (extensionApi.env.isLinux) {
        await this.uninstallLinux(logger);
      } else {
        throw new Error('OpenShell uninstall is not supported on this platform');
      }
      logger.log('OpenShell uninstalled successfully');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`OpenShell uninstall failed: ${message}`);
      throw error;
    }
  }

  private async fetchPinnedVersion(): Promise<string> {
    const release = await getRelease(this.#openshellVersion);
    return release.version;
  }

  private async uninstallLinux(logger: Logger): Promise<void> {
    const hasDnf = await this.hasCommand('dnf');
    if (hasDnf) {
      await extensionApi.process.exec('dnf', ['remove', '-y', 'openshell', 'openshell-gateway'], {
        logger,
        isAdmin: true,
      });
      return;
    }

    const hasApt = await this.hasCommand('apt-get');
    if (hasApt) {
      await extensionApi.process.exec('apt-get', ['remove', '-y', 'openshell', 'openshell-gateway'], {
        logger,
        isAdmin: true,
      });
      return;
    }

    const hasRpm = await this.hasCommand('rpm');
    if (hasRpm) {
      await extensionApi.process.exec('rpm', ['-e', 'openshell', 'openshell-gateway'], { logger, isAdmin: true });
      return;
    }

    throw new Error('no supported package manager found (dnf, apt-get, rpm)');
  }

  private async hasCommand(cmd: string): Promise<boolean> {
    try {
      await extensionApi.process.exec('which', [cmd]);
      return true;
    } catch {
      return false;
    }
  }
}
