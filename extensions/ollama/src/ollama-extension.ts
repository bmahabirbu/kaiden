/**********************************************************************
 * Copyright (C) 2025 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer, request } from 'node:http';
import { networkInterfaces } from 'node:os';

import { type Disposable, type ExtensionContext, type Provider, provider } from '@openkaiden/api';
import { createOllama } from 'ollama-ai-provider-v2';

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

export class OllamaExtension {
  #extensionContext: ExtensionContext;
  #currentModels: string[] = [];
  #connectionDisposable: Disposable | undefined;
  #interval: NodeJS.Timeout | undefined;
  #proxyServer: Server | undefined;
  #proxyPort: number | undefined;

  constructor(extensionContext: ExtensionContext) {
    this.#extensionContext = extensionContext;
  }

  async activate(): Promise<void> {
    await this.startProxy();

    const ollamaProvider = provider.createProvider({
      name: 'Ollama',
      status: 'unknown',
      id: 'ollama',
      images: {
        icon: './icon.png',
        logo: {
          dark: './icon.png',
          light: './icon.png',
        },
      },
      links: [{ title: 'Website', url: 'https://ollama.com' }],
    });
    this.#extensionContext.subscriptions.push(ollamaProvider);

    await this.updateModelsAndStatus(ollamaProvider);
    this.#interval = setInterval(() => {
      this.updateModelsAndStatus(ollamaProvider).catch((error: unknown) => {
        console.error('Error updating Ollama models and status:', error);
      });
    }, 30000);
  }

  protected startProxy(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#proxyServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const proxyReq = request(
          {
            hostname: OLLAMA_HOST,
            port: OLLAMA_PORT,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          proxyRes => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on('error', () => {
          res.writeHead(502);
          res.end();
        });
        req.pipe(proxyReq);
      });

      this.#proxyServer.listen(0, '0.0.0.0', () => {
        const addr = this.#proxyServer!.address();
        if (addr && typeof addr === 'object') {
          this.#proxyPort = addr.port;
        }
        resolve();
      });
      this.#proxyServer.on('error', reject);
    });
  }

  protected getEndpoint(): string {
    if (this.#proxyPort) {
      return `http://${getLocalIP()}:${this.#proxyPort}/v1`;
    }
    return `http://${OLLAMA_HOST}:${OLLAMA_PORT}/v1`;
  }

  protected async updateModelsAndStatus(ollamaProvider: Provider): Promise<void> {
    let models: Array<{ name: string }> = [];
    let running = true;
    try {
      const res = await fetch(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`);
      if (!res.ok) {
        throw new Error(`HTTP error, status: ${res.status}`);
      }
      const data = await res.json();
      models =
        data !== null && typeof data === 'object' && 'models' in data
          ? Array.isArray(data.models)
            ? data.models
            : []
          : [];
    } catch (_err: unknown) {
      running = false;
      models = [];
    }

    // Update provider status
    if (!running) {
      ollamaProvider.updateStatus('stopped');
      // deregister previous connection if exists
      if (this.#connectionDisposable) {
        this.#connectionDisposable.dispose();
        this.#connectionDisposable = undefined;
      }
      this.#currentModels = [];
      return;
    }

    ollamaProvider.updateStatus('started');
    const newModelNames = models.map(m => m.name).sort((a, b) => a.localeCompare(b));
    const oldModelNames = this.#currentModels.slice().sort((a, b) => a.localeCompare(b));
    const modelsChanged =
      newModelNames.length !== oldModelNames.length || newModelNames.some((v, i) => v !== oldModelNames[i]);

    if (modelsChanged) {
      // Unregister previous connection if exists
      if (this.#connectionDisposable) {
        this.#connectionDisposable.dispose();
        this.#connectionDisposable = undefined;
      }
      this.#currentModels = newModelNames;
      if (newModelNames.length > 0) {
        const endpoint = this.getEndpoint();
        const sdk = createOllama();
        const disposable = ollamaProvider.registerInferenceProviderConnection({
          name: 'ollama',
          type: 'local',
          llmMetadata: { name: 'ollama' },
          endpoint,
          sdk,
          status() {
            return 'started';
          },
          models: models.map(model => ({ label: model.name })),
          credentials() {
            return {};
          },
        });
        this.#connectionDisposable = disposable;
        this.#extensionContext.subscriptions.push(disposable);
      }
    }
  }

  async deactivate(): Promise<void> {
    clearInterval(this.#interval);
    this.#currentModels = [];
    if (this.#proxyServer) {
      this.#proxyServer.close();
      this.#proxyServer = undefined;
      this.#proxyPort = undefined;
    }
  }
}
