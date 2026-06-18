/**
 * web/lib/rateLimit.ts — In-process token-bucket rate limiter.
 */
interface Bucket { count: number; windowStart: number; }
const _buckets = new Map<string, Bucket>();
interface RateLimitResult { ok: boolean; remaining: number; retryAfter?: number; }

export function rateLimit(identifier: string, namespace: string, limit: number, windowSec: number): RateLimitResult {
  const key = `${namespace}:${identifier}`;
  const now = Date.now();
  const winMs = windowSec * 1_000;
  let bucket = _buckets.get(key);
  if (!bucket || now - bucket.windowStart >= winMs) {
    _buckets.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: limit - 1 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((winMs - (now - bucket.windowStart)) / 1_000) };
  }
  return { ok: true, remaining: limit - bucket.count };
}

const PRUNE_MS = 5 * 60 * 1_000;
let _lastPrune = Date.now();
export function pruneExpiredBuckets(windowSec: number): void {
  const now = Date.now();
  if (now - _lastPrune < PRUNE_MS) return;
  _lastPrune = now;
  for (const [k, b] of _buckets.entries()) {
    if (now - b.windowStart >= windowSec * 2_000) _buckets.delete(k);
  }
}
