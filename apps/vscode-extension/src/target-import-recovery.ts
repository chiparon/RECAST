import type { PendingTargetImport } from './target-workspace';

interface RecoveryStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Keep the intent across failure/restart; acknowledge success or explicit cancellation only. */
export async function completeTargetImport(
  store: RecoveryStore, key: string, pending: PendingTargetImport, operation: () => Promise<void>,
): Promise<void> {
  const acknowledge = async () => {
    const current = store.get<PendingTargetImport>(key);
    // A late completion must not erase an import the user started afterwards.
    if (current?.requestedAt === pending.requestedAt && current.mode === pending.mode) await store.update(key, undefined);
  };
  try { await operation(); }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') await acknowledge();
    throw error;
  }
  await acknowledge();
}
