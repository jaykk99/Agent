/** Tests for lib/rateLimit.ts (the shared token-bucket limiter used by /api/chat). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, pruneExpiredBuckets, getClientIp } from '../lib/rateLimit.ts';

const hdr = (h: Record<string, string | null>) => ({ headers: { get: (n: string) => h[n] ?? null } });

describe('rateLimit', () => {
  it('allows up to the limit, then blocks with a retryAfter', () => {
    const ns = `t${Date.now()}`;
    for (let i = 0; i < 20; i++) {
      const r = rateLimit('ip-1', ns, 20, 60);
      assert.equal(r.ok, true);
      assert.equal(r.remaining, 19 - i);
    }
    const blocked = rateLimit('ip-1', ns, 20, 60);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.remaining, 0);
    assert.ok((blocked.retryAfter ?? 0) > 0 && (blocked.retryAfter ?? 0) <= 60);
  });

  it('buckets are per namespace + identifier', () => {
    const ns = `t${Date.now()}`;
    for (let i = 0; i < 5; i++) rateLimit('same-ip', ns, 3, 60);
    assert.equal(rateLimit('same-ip', ns, 3, 60).ok, false);
    assert.equal(rateLimit('same-ip', `${ns}-other`, 3, 60).ok, true);
    assert.equal(rateLimit('other-ip', ns, 3, 60).ok, true);
  });

  it('pruneExpiredBuckets runs without throwing', () => {
    pruneExpiredBuckets(60);
    pruneExpiredBuckets(60); // second call inside the prune window is a no-op
  });
});

describe('getClientIp', () => {
  it('prefers x-forwarded-for first entry, then x-real-ip, then loopback', () => {
    assert.equal(getClientIp(hdr({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4');
    assert.equal(getClientIp(hdr({ 'x-real-ip': '9.9.9.9' })), '9.9.9.9');
    assert.equal(getClientIp(hdr({})), '127.0.0.1');
  });
});
