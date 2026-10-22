import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BackendProcess, type BackendLaunchConfiguration } from './backend-process';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(existing = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recast-backend-'))); roots.push(root);
  await mkdir(path.join(root, 'dist/extension'), { recursive: true });
  await writeFile(path.join(root, 'dist/extension/adaptation-server.cjs'), '');
  const config: BackendLaunchConfiguration = { url: 'http://127.0.0.1:8788', extensionPath: root, workspaceRoot: root,
    trusted: true, autoStart: true, semanticPort: 8790 };
  const capabilities = { service: 'recast-adaptation', version: 1, retrievalRerank: true, semanticPlanning: true, workspaceTranslation: true, workspaceRoot: root, semanticQueryUrl: 'http://127.0.0.1:8790' };
  let running = existing;
  const child = Object.assign(new EventEmitter(), { connected: true, kill: vi.fn(), send: vi.fn(), stdout: { resume() {} }, stderr: { resume() {} } });
  const launch = vi.fn(() => { running = true; return child; });
  const transport = vi.fn(async (url: Parameters<typeof fetch>[0]) => running ? Response.json(String(url).endsWith('/configuration') ? { workspaceRoot: root } : capabilities) : new Response('', { status: 503 }));
  const manager = new BackendProcess(() => config, vi.fn(), launch as any, transport);
  return { root, config, capabilities, child, launch, manager, transport };
}
it('shares concurrent startup, uses a hidden owned process, and shuts it down over IPC', async () => {
  const { manager, launch, child, root } = await setup();
  const first = manager.ensure(); expect(manager.ensure()).toBe(first); await first;
  await manager.ensure(); expect(launch).toHaveBeenCalledTimes(1);
  const options = (launch.mock.calls[0] as any)[2];
  expect(options).toMatchObject({ cwd: root, shell: false, windowsHide: true });
  expect(options.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN).toBe(manager.translationToken);
  expect(options.env.ADAPTATION_PROJECT_ROOT).toBe(root);
  manager.dispose(); expect(child.send).toHaveBeenCalledWith({ type: 'shutdown' }, expect.any(Function));
  await expect(manager.ensure()).rejects.toThrow('disposed');
});
it('starts planning services without a target and enables translation after target import', async () => {
  const { manager, config, capabilities, child, launch, transport, root } = await setup();
  config.workspaceTranslation = false;
  capabilities.workspaceTranslation = false;
  await manager.ensure();
  expect((launch.mock.calls[0] as any)[2].env.ADAPTATION_WORKSPACE_TRANSLATION_ENABLED).toBe('false');
  expect(transport.mock.calls.some(([url]) => String(url).endsWith('/configuration'))).toBe(false);
  child.send.mockImplementation(() => queueMicrotask(() => child.emit('exit', 0, null)));
  config.workspaceTranslation = true;
  capabilities.workspaceTranslation = true;
  transport.mockResolvedValueOnce(new Response('', { status: 503 }));
  await manager.ensure();
  expect(launch).toHaveBeenCalledTimes(2);
  expect((launch.mock.calls[1] as any)[2].env.ADAPTATION_WORKSPACE_TRANSLATION_ENABLED).toBe('true');
  expect(transport.mock.calls.some(([url]) => String(url).endsWith('/configuration'))).toBe(true);
  // Real target ownership remains protected, even after service bootstrap.
  const otherRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'recast-other-target-'))); roots.push(otherRoot);
  config.workspaceRoot = otherRoot;
  await expect(manager.ensure()).rejects.toThrow('另一目标');
  config.workspaceRoot = root;
  manager.dispose();
});
it('reuses a compatible external backend without killing it', async () => {
  const { manager, launch, child } = await setup(true);
  await manager.ensure(); manager.dispose(); expect(launch).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
});
it('refuses untrusted workspaces and disabled automatic startup', async () => {
  const { manager, config, launch } = await setup(); config.trusted = false;
  await expect(manager.ensure()).rejects.toThrow('信任'); config.trusted = true; config.autoStart = false;
  await expect(manager.ensure()).rejects.toThrow('已关闭'); expect(launch).not.toHaveBeenCalled();
});
it('refuses remote auto-start and incompatible existing targets', async () => {
  const first = await setup(); first.config.url = 'http://example.com';
  await expect(first.manager.ensure()).rejects.toThrow('本机'); expect(first.launch).not.toHaveBeenCalled();
  const second = await setup(true); second.capabilities.workspaceRoot = first.root;
  await expect(second.manager.ensure()).rejects.toThrow('其他目标'); expect(second.launch).not.toHaveBeenCalled();
});
it('cleans up a child that fails ownership authentication', async () => {
  const { manager, transport, child, root } = await setup();
  transport.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({
    service: 'recast-adaptation', version: 1, retrievalRerank: true, semanticPlanning: true, workspaceTranslation: true, workspaceRoot: root, semanticQueryUrl: 'http://127.0.0.1:8790',
  })).mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(manager.ensure()).rejects.toThrow('鉴权'); expect(child.kill).toHaveBeenCalledOnce();
});
it('refuses an existing backend with a stale window scope or missing workspace identity', async () => {
  const { manager, capabilities, launch, child } = await setup(true);
  capabilities.semanticQueryUrl = 'http://127.0.0.1:9876';
  await expect(manager.ensure()).rejects.toThrow('语义查询端口');
  capabilities.semanticQueryUrl = 'http://127.0.0.1:8790';
  capabilities.workspaceRoot = '';
  await expect(manager.ensure()).rejects.toThrow('其他目标');
  manager.dispose();
  expect(launch).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});

it('refuses an unauthenticated external backend without terminating it', async () => {
  const { manager, capabilities, transport, launch, child } = await setup(true);
  transport.mockImplementation(async url => String(url).endsWith('/configuration')
    ? new Response('', { status: 401 }) : Response.json(capabilities));
  await expect(manager.ensure()).rejects.toThrow('鉴权');
  manager.dispose();
  expect(launch).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});

it('does not launch after disposal while its async endpoint configuration is pending', async () => {
  const { config, launch, transport } = await setup();
  let resolve!: (config: BackendLaunchConfiguration) => void;
  const configuration = new Promise<BackendLaunchConfiguration>(ready => { resolve = ready; });
  // This launcher returns the fixture's event-only child instead of an OS process.
  const launchChild = launch as unknown as typeof spawn;
  const manager = new BackendProcess(() => configuration, vi.fn(), launchChild, transport);
  const pending = manager.ensure();
  manager.dispose();
  resolve(config);
  await expect(pending).rejects.toThrow('disposed');
  expect(launch).not.toHaveBeenCalled();
});

it('keeps a verified owned process usable after transient probes and rechecks it later', async () => {
  const { manager, transport, child, launch, capabilities, root } = await setup();
  await manager.ensure();
  const initialCalls = transport.mock.calls.length;
  await manager.ensure();
  expect(transport).toHaveBeenCalledTimes(initialCalls);
  let now = Date.now() + 31_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  transport.mockRejectedValue(new DOMException('slow machine', 'TimeoutError'));
  await expect(manager.ensure()).resolves.toEqual(capabilities);
  expect(manager.healthPending).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(1);
  now += 5100;
  transport.mockImplementation(async url => Response.json(String(url).endsWith('/configuration') ? { workspaceRoot: root } : capabilities));
  await manager.ensure();
  expect(manager.healthPending).toBe(false);
  child.emit('exit', 1, null);
  expect(manager.url).toBeUndefined();
});

it('uses only the child-announced port for an owned dynamic backend', async () => {
  const { manager, config, child, transport, launch } = await setup();
  config.dynamicPort = true;
  const original = launch.getMockImplementation()!;
  launch.mockImplementation((...args: any[]) => {
    const result = (original as any)(...args);
    setImmediate(() => child.emit('message', { type: 'listening', port: 45678 }));
    return result;
  });
  await manager.ensure();
  expect((launch.mock.calls[0] as any)[2].env.ADAPTATION_PORT).toBe('0');
  expect(manager.url).toBe('http://127.0.0.1:45678');
  expect(transport.mock.calls.slice(1).every(([url]) => String(url).startsWith(manager.url!))).toBe(true);
  manager.dispose();
});

it('retries a startup authentication timeout but never ignores an explicit rejection', async () => {
  const { manager, transport, child, root, capabilities } = await setup();
  transport.mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json(capabilities))
    .mockRejectedValueOnce(new DOMException('busy', 'TimeoutError'))
    .mockResolvedValueOnce(Response.json(capabilities))
    .mockResolvedValueOnce(Response.json({ workspaceRoot: root }));
  await expect(manager.ensure()).resolves.toEqual(capabilities);
  expect(child.kill).not.toHaveBeenCalled();
  manager.dispose();
});
