export interface SchedulerOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
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
  /** JSON payload for write methods. Never set for reads. */
  body?: string;
}

export interface Scheduler {
  run(req: SchedulerRequest): Promise<SchedulerResponse>;
}

const CACHEABLE = new Set(["GET", "HEAD"]);

/** Methods it is safe to re-send. Deliberately separate from CACHEABLE. */
const RETRY_SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Serializes requests with human-shaped pacing, dedups cacheable requests by
 * URL for its lifetime, and (Task 2) backs off on 429/503. Owns the fetch so
 * it can see the URL for dedup and the status for backoff — the previous
 * opaque-thunk limiter could see neither.
 */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const min = options.minDelayMs ?? 400;
  const max = Math.max(options.maxDelayMs ?? 1300, min);
  const maxRetries = options.maxRetries ?? 3;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let tail: Promise<unknown> = Promise.resolve();
  let first = true;
  const cache = new Map<string, Promise<SchedulerResponse>>();

  const RETRYABLE = new Set([429, 503]);

  async function fetchWithBackoff(req: SchedulerRequest): Promise<SchedulerResponse> {
    // A write is not idempotent: a request the server already committed before
    // answering 429/503 would be applied twice by a retry. Use a dedicated
    // predicate, NOT the CACHEABLE dedup set: coupling retry-safety to a caching
    // constant means a future caching change silently changes write safety.
    const retryable = RETRY_SAFE_METHODS.has(req.method.toUpperCase());
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const out = { status: res.status, body: await res.text(), headers };
      if (!retryable || !RETRYABLE.has(res.status) || attempt >= maxRetries) return out;

      const retryAfter = Number(headers["retry-after"]);
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  function once(req: SchedulerRequest): Promise<SchedulerResponse> {
    const run = tail.then(async () => {
      if (first) {
        first = false;
      } else {
        const delay = min + Math.floor(Math.random() * (max - min + 1));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      return fetchWithBackoff(req);
    });
    tail = run.catch(() => undefined);
    run.then((r) => {
      if (r.status < 200 || r.status >= 300) cache.delete(req.url);
    }).catch(() => cache.delete(req.url));
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
