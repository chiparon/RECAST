// @vitest-environment node
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { OutputChannel } from 'vscode';
vi.mock('vscode', () => ({ workspace: { getConfiguration: () => ({
  get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined,
}) } }));
import { BackendProcess } from './backend-process';
import { ServiceManager } from './service-manager';
import type { CodeIntelligencePresentation } from './ui-types';

it('keeps the indexing service connected when an individual repository fails', () => {
  const manager = new ServiceManager({ appendLine: vi.fn() } as unknown as OutputChannel);
  manager.setIndexStatus({ status: 'error', runtimeStatus: 'ready', storage: 'seekdb', repositories: [] });
  expect(manager.serviceStatus.moduleSearch).toBe('connected');
  manager.setIndexStatus({ status: 'error', storage: 'seekdb', repositories: [] } as CodeIntelligencePresentation);
  expect(manager.serviceStatus.moduleSearch).toBe('error');
});

it('keeps index initialization pending until backend readiness is confirmed', async () => {
  let resolve!: () => void;
  const ensure = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const manager = new ServiceManager({ appendLine: vi.fn() } as unknown as OutputChannel,
    { ensure, dispose: vi.fn() } as unknown as BackendProcess);
  manager.setIndexInitialization('等待数据库升级');
  const pending = manager.ensureStarted();
  expect(manager.serviceStatus).toMatchObject({ moduleSearch: 'starting', adaptation: 'starting', message: '等待数据库升级' });
  expect(() => manager.getAdaptationPort()).toThrow('等待数据库升级');
  resolve(); await pending;
  expect(manager.serviceStatus.adaptation).toBe('connected');
  expect(manager.serviceStatus.message).toBeUndefined();
});

it('keeps an unauthorized backend red even when its public health endpoint is healthy', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recast-service-status-')));
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/capabilities') response.end(JSON.stringify({
      service: 'recast-adaptation', version: 1, retrievalRerank: true, semanticPlanning: true,
      workspaceTranslation: true, workspaceRoot: root, semanticQueryUrl: 'http://127.0.0.1:8790',
    }));
    else if (request.url === '/v1/workspace-translations/configuration') {
      response.writeHead(401); response.end('{"error":"Unauthorized"}');
    } else response.end('{"status":"ok"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server');
  const url = `http://127.0.0.1:${address.port}`;
  const backend = new BackendProcess(() => ({ url, extensionPath: root, workspaceRoot: root,
    trusted: true, autoStart: false, semanticPort: 8790 }), () => {});
  // The service manager only appends diagnostics to the VS Code output channel.
  const output = { appendLine: vi.fn() } as unknown as OutputChannel;
  const manager = new ServiceManager(output, backend);
  try {
    await expect(manager.ensureStarted()).rejects.toThrow('鉴权');
    const status = await manager.refresh();
    expect(status.adaptation).toBe('error');
    expect(status.message).toContain('鉴权');
    expect(() => manager.getAdaptationPort()).toThrow('鉴权');
    manager.dispose();
    expect((await fetch(`${url}/health`)).status).toBe(200);
  } finally {
    manager.dispose();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});
