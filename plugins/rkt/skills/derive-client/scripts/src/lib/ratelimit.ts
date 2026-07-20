export interface LimiterOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Serialize calls and space them by a randomized delay, so automated traffic
 * keeps a human shape. Concurrency is fixed at 1 by design: this is a
 * politeness guardrail, not a throughput knob.
 *
 * The first call is not delayed; pacing applies between successive calls.
 */
export function createLimiter(options: LimiterOptions = {}) {
  const min = options.minDelayMs ?? 400;
  const max = Math.max(options.maxDelayMs ?? 1300, min);

  let tail: Promise<unknown> = Promise.resolve();
  let first = true;

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      if (first) {
        first = false;
      } else {
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      return fn();
    });

    // Keep the chain alive even when a task rejects.
    tail = run.catch(() => undefined);
    return run;
  };
}
