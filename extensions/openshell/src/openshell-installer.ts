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

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CliToolInstaller, Logger } from '@openkaiden/api';
import * as extensionApi from '@openkaiden/api';

const OPENSHELL_REPO = 'NVIDIA/OpenShell';
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${OPENSHELL_REPO}/main/install.sh`;

export class OpenshellInstaller implements CliToolInstaller {
  private selectedVersion: string | undefined;

  async selectVersion(latest?: boolean): Promise<string> {
    if (latest || !this.selectedVersion) {
      this.selectedVersion = await this.fetchLatestVersion();
    }
    return this.selectedVersion;
  }

  async doInstall(logger: Logger): Promise<void> {
    const scriptPath = this.findInstallScript();

    if (scriptPath) {
      logger.log(`Using bundled install script: ${scriptPath}`);
    } else {
      logger.log('Bundled install script not found, will use upstream installer directly');
    }

    logger.log('Installing OpenShell...');

    try {
      if (scriptPath) {
        await extensionApi.process.exec('sh', [scriptPath], { logger, isAdmin: true });
      } else {
        await this.installFromUpstream(logger);
      }
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

  private async fetchLatestVersion(): Promise<string> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
    const res = await fetch(`https://api.github.com/repos/${OPENSHELL_REPO}/releases/latest`, {
      headers,
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`failed to fetch latest OpenShell release: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { tag_name: string };
    return data.tag_name.replace(/^v/, '');
  }

  private findInstallScript(): string | undefined {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const bundledPath = join(resourcesPath, 'openshell', 'install.sh');
      if (existsSync(bundledPath)) {
        return bundledPath;
      }
    }
    return undefined;
  }

  private async installFromUpstream(logger: Logger): Promise<void> {
    logger.log(`Downloading install script from ${INSTALL_SCRIPT_URL}`);
    const res = await fetch(INSTALL_SCRIPT_URL, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`failed to download install.sh: ${res.status} ${res.statusText}`);
    }
    const script = await res.text();
    await extensionApi.process.exec('sh', ['-c', script], { logger, isAdmin: true });
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
      await extensionApi.process.exec('apt-get', ['remove', '-y', 'openshell'], { logger, isAdmin: true });
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
