/**
 * web/app/api/execute-api/route.ts
 * Executes arbitrary HTTP API calls requested by the agent or user.
 * Includes: SSRF protection, timeout, rate limiting, input validation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIp } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic  = 'force-dynamic';

// SSRF blocklist — prevent hitting internal services
const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254',   // AWS/GCP metadata
  '100.100.100.200',   // Alibaba metadata
  '192.168.', '10.', '172.16.', '172.17.', '172.18.',
  '172.19.', '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.', '172.28.',
  '172.29.', '172.30.', '172.31.',
];

const BLOCKED_SCHEMES = ['file:', 'ftp:', 'gopher:', 'data:'];

function isSafeUrl(rawUrl: string): { ok: boolean; reason?: string } {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return { ok: false, reason: 'Invalid URL' }; }

  if (BLOCKED_SCHEMES.some(s => parsed.protocol === s)) {
    return { ok: false, reason: `Scheme ${parsed.protocol} not allowed` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http/https allowed' };
  }
  const host = parsed.hostname.toLowerCase();
  for (const blocked of BLOCKED_HOSTS) {
    if (host === blocked || host.startsWith(blocked)) {
      return { ok: false, reason: `Host ${host} is not reachable from this server` };
    }
  }
  return { ok: true };
}

export async function POST(req: NextRequest) {
  // Rate limit: 30 calls / 60s per IP
  const ip = getClientIp(req);
  const rl = rateLimit(ip, 'execute-api', 30, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${rl.retryAfter}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  let body: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { url, method = 'GET', headers: reqHeaders = {}, params = {}, body: reqBody } = body;

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }

  const safety = isSafeUrl(url);
  if (!safety.ok) {
    return NextResponse.json({ error: safety.reason }, { status: 400 });
  }

  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  const upperMethod = (method || 'GET').toUpperCase();
  if (!allowedMethods.includes(upperMethod)) {
    return NextResponse.json({ error: `Method ${method} not allowed` }, { status: 400 });
  }

  // Build URL with query params
  let finalUrl = url;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString();
    finalUrl = `${url}${url.includes('?') ? '&' : '?'}${qs}`;
  }

  // Sanitize headers — strip hop-by-hop and dangerous headers
  const BLOCKED_HEADERS = ['host', 'connection', 'transfer-encoding', 'upgrade'];
  const safeHeaders: Record<string, string> = { 'User-Agent': 'AIAgent/1.0' };
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (!BLOCKED_HEADERS.includes(k.toLowerCase()) && typeof v === 'string') {
      safeHeaders[k] = v;
    }
  }

  try {
    const fetchOptions: RequestInit = {
      method: upperMethod,
      headers: safeHeaders,
      signal: AbortSignal.timeout(15000), // 15s timeout
    };

    if (reqBody && !['GET', 'HEAD', 'DELETE'].includes(upperMethod)) {
      fetchOptions.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
      if (!safeHeaders['Content-Type'] && !safeHeaders['content-type']) {
        safeHeaders['Content-Type'] = 'application/json';
      }
    }

    const res = await fetch(finalUrl, fetchOptions);
    const contentType = res.headers.get('content-type') || '';
    let responseBody: string;

    // Cap response at 100KB
    const raw = await res.text();
    responseBody = raw.slice(0, 100_000);
    if (raw.length > 100_000) responseBody += '\n...(truncated at 100KB)';

    // Try to pretty-print JSON
    let prettyBody = responseBody;
    if (contentType.includes('application/json')) {
      try { prettyBody = JSON.stringify(JSON.parse(responseBody), null, 2); } catch { /* use raw */ }
    }

    return NextResponse.json({
      status_code: res.status,
      status_text: res.statusText,
      content_type: contentType,
      body: prettyBody,
      url: finalUrl,
      method: upperMethod,
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Request failed';
    if (msg.includes('TimeoutError') || msg.includes('timed out')) {
      return NextResponse.json({ error: 'Request timed out (15s limit)' }, { status: 504 });
    }
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
