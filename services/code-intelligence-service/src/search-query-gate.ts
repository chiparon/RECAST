/** Bound expensive search SQL before it occupies the shared connection pool. */
export class SearchQueryGate {
  #active = 0;
  readonly #waiters: Array<{ grant: () => void; signal?: AbortSignal; cancel?: () => void }> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) {
      throw new Error('Search SQL concurrency must be an integer in 1..32.');
    }
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        cancel: undefined as (() => void) | undefined,
        grant: () => {
          if (waiter.cancel) signal!.removeEventListener('abort', waiter.cancel);
          this.#active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.#active -= 1;
            this.drain();
          });
        },
      };
      if (signal) {
        waiter.cancel = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', waiter.cancel, { once: true });
      }
      this.#waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (this.#active < this.limit && this.#waiters.length) {
      const next = this.#waiters.shift()!;
      if (next.signal?.aborted) {
        next.cancel?.();
        continue;
      }
      next.grant();
    }
  }
}
