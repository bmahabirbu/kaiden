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
import { resolve } from 'node:path';

import { window } from '@openkaiden/api';
import { inject, injectable } from 'inversify';

import type { SocketFinder } from '/@/api/socket-finder';
import { PodmanVersionDetector } from '/@/helper/socket-finder/podman/podman-version-detector';

@injectable()
export class PodmanSocketLinuxFinder implements SocketFinder {
  @inject(PodmanVersionDetector)
  private readonly versionDetector: PodmanVersionDetector;

  // findPaths() runs on a periodic discovery poll, so warn at most once per session to
  // avoid spamming the user while the socket stays disabled.
  #warnedSocketNotActivated = false;

  async findPaths(): Promise<string[]> {
    const paths: string[] = [];

    // Rootless socket via XDG_RUNTIME_DIR (e.g. /run/user/1000/podman/podman.sock)
    // Falls back to /run/user/$UID for headless/SSH/non-systemd environments
    const uid = process.getuid?.();
    const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR ?? (uid !== undefined ? `/run/user/${uid}` : undefined);
    const rootlessSocket = xdgRuntimeDir ? resolve(xdgRuntimeDir, 'podman/podman.sock') : undefined;
    if (rootlessSocket && existsSync(rootlessSocket)) {
      paths.push(rootlessSocket);
    }

    // Rootful socket
    const rootfulSocket = '/run/podman/podman.sock';
    if (existsSync(rootfulSocket)) {
      paths.push(rootfulSocket);
    }

    if (paths.length === 0) {
      // Kaiden relies on external tools rather than starting or configuring them: just let
      // the user know the socket is not active and how to enable it themselves.
      await this.warnSocketNotActivated(rootlessSocket);
    } else {
      // Re-arm the warning so the user is told again if the socket later disappears.
      this.#warnedSocketNotActivated = false;
    }

    return paths;
  }

  protected async warnSocketNotActivated(rootlessSocket: string | undefined): Promise<void> {
    if (this.#warnedSocketNotActivated) {
      return;
    }
    // Reserve the warning synchronously, before the async install check below, so overlapping
    // discovery polls cannot both pass this guard while isInstalled() is pending and double-warn.
    this.#warnedSocketNotActivated = true;

    // Only nudge users who actually have podman installed; Docker-only hosts stay silent.
    if (!(await this.versionDetector.isInstalled())) {
      return;
    }

    const socket = rootlessSocket ?? '/run/user/<uid>/podman/podman.sock';
    // Fire-and-forget: socket discovery must not block on the user dismissing the notification.
    window
      .showWarningMessage(
        `Podman is installed but its API socket was not found at ${socket}. ` +
          'Enable the rootless Podman socket so Kaiden can connect to it by running ' +
          '"systemctl --user enable --now podman.socket" (verify it with ' +
          '"systemctl --user status podman.socket").',
      )
      .catch((error: unknown) => {
        console.error('Failed to show the podman socket warning:', error);
      });
  }
}
