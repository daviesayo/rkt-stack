export interface SchedulerOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SchedulerResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface SchedulerRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface Scheduler {
  run(req: SchedulerRequest): Promise<SchedulerResponse>;
}

const CACHEABLE = new Set(["GET", "HEAD"]);

/**
 * Serializes requests with human-shaped pacing, dedups cacheable requests by
 * URL for its lifetime, and (Task 2) backs off on 429/503. Owns the fetch so
 * it can see the URL for dedup and the status for backoff — the previous
 * opaque-thunk limiter could see neither.
 */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const min = options.minDelayMs ?? 400;
  const max = Math.max(options.maxDelayMs ?? 1300, min);
  const doFetch = options.fetchImpl ?? fetch;

  let tail: Promise<unknown> = Promise.resolve();
  let first = true;
  const cache = new Map<string, Promise<SchedulerResponse>>();

  function once(req: SchedulerRequest): Promise<SchedulerResponse> {
    const run = tail.then(async () => {
      if (first) {
        first = false;
      } else {
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      const res = await doFetch(req.url, { method: req.method, headers: req.headers });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, body: await res.text(), headers };
    });
    tail = run.catch(() => undefined);
    return run;
  }

  return {
    run(req) {
      const cacheable = CACHEABLE.has(req.method.toUpperCase());
      if (cacheable) {
        const hit = cache.get(req.url);
        if (hit) return hit;
      }
      const p = once(req);
      if (cacheable) cache.set(req.url, p);
      return p;
    },
  };
}
