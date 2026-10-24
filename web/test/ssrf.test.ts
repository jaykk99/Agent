/** Tests for lib/ssrf.ts (the execute-api SSRF guard). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeUrl } from '../lib/ssrf.ts';

describe('isSafeUrl', () => {
  it('allows public hostnames that merely start with blocked prefixes', () => {
    // Public DNS names, not private addresses — the old startsWith()
    // match blocked all of these.
    for (const url of [
      'https://10.example.com/',
      'https://192.168.example.com/',
      'https://172.16.example.com/',
      'https://localhost.example.com/',
    ]) {
      assert.equal(isSafeUrl(url).ok, true, url);
    }
  });
  it('still blocks private hosts, metadata IPs, and bad schemes', () => {
    for (const url of [
      'http://localhost/',
      'http://localhost./', // trailing-dot form must not slip past
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/',
      'http://100.100.100.200/',
      'http://0.0.0.0/',
      'file:///etc/passwd',
      'ftp://example.com/',
    ]) {
      assert.equal(isSafeUrl(url).ok, false, url);
    }
  });
  it('allows ordinary public URLs', () => {
    assert.equal(isSafeUrl('https://example.com/').ok, true);
  });
});
