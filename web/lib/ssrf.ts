/**
 * lib/ssrf.ts — SSRF guard for the execute-api route, dependency-free so it
 * is unit-testable without Next.js.
 *
 * Rules (unchanged in spirit, fixed in matching):
 * - Only http/https URLs.
 * - Blocked hostnames/IP literals match EXACTLY (after lowercasing and
 *   stripping one trailing dot, so "localhost." cannot slip past).
 * - Blocked IP-prefix entries ("192.168.", "10.", "172.16.", ...) match
 *   ONLY literal IPv4 addresses. The old startsWith() check also blocked
 *   public DNS names that merely begin with those digits ("10.example.com",
 *   "192.168.example.com", "localhost.example.com"), which are ordinary
 *   public hostnames, not private addresses.
 */

// SSRF blocklist — prevent hitting internal services
export const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254',   // AWS/GCP metadata
  '100.100.100.200',   // Alibaba metadata
  '192.168.', '10.', '172.16.', '172.17.', '172.18.',
  '172.19.', '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.', '172.28.',
  '172.29.', '172.30.', '172.31.',
];

export const BLOCKED_SCHEMES = ['file:', 'ftp:', 'gopher:', 'data:'];

export function isSafeUrl(rawUrl: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return { ok: false, reason: 'Invalid URL' }; }

  if (BLOCKED_SCHEMES.some(s => parsed.protocol === s)) {
    return { ok: false, reason: `Scheme ${parsed.protocol} not allowed` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http/https allowed' };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  for (const blocked of BLOCKED_HOSTS) {
    if (blocked.endsWith('.')) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.startsWith(blocked)) {
        return { ok: false, reason: `Host ${host} is not reachable from this server` };
      }
    } else if (host === blocked) {
      return { ok: false, reason: `Host ${host} is not reachable from this server` };
    }
  }
  return { ok: true };
}
