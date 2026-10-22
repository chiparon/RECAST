// @vitest-environment node
import { expect, it } from 'vitest';
import { completeTargetImport } from './target-import-recovery';
import type { PendingTargetImport } from './target-workspace';

it('retains a failed recovery across host restarts and acknowledges a later success', async () => {
  const pending: PendingTargetImport = { requestedAt: new Date().toISOString(), mode: 'browse' };
  const values = new Map<string, unknown>([['intent', pending]]);
  const store = { get: <T,>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, value); } };
  await expect(completeTargetImport(store, 'intent', pending, async () => { throw new Error('database busy'); })).rejects.toThrow('busy');
  expect(values.get('intent')).toBe(pending);
  await completeTargetImport(store, 'intent', pending, async () => { expect(values.get('intent')).toBe(pending); });
  expect(values.get('intent')).toBeUndefined();
});

it('acknowledges explicit cancellation without clearing a newer import', async () => {
  const pending: PendingTargetImport = { requestedAt: '2026-10-19T00:00:00Z', mode: 'browse' };
  let current: unknown = pending;
  const store = { get: <T,>() => current as T | undefined, update: async (_key: string, value: unknown) => { current = value; } };
  await expect(completeTargetImport(store, 'intent', pending, async () => { throw new DOMException('cancelled', 'AbortError'); })).rejects.toThrow('cancelled');
  expect(current).toBeUndefined();
  const newer = { ...pending, requestedAt: '2026-10-19T00:01:00Z' };
  current = newer;
  await completeTargetImport(store, 'intent', pending, async () => {});
  expect(current).toBe(newer);
});
