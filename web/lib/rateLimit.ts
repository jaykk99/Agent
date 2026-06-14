/**
 * lib/rateLimit.ts
 * In-memory rate limiter for Next.js Edge/Node routes.
 * Usage: const { ok, retryAfter } = rateLimit(ip, 'chat', 20, 60);
 */

const _store = new Map<string, { count: number; reset: number }>();

/**
 * @param id       unique key (IP or session_id)
 * @param action   route name for namespacing
 * @param limit    max requests per window
 * @param windowSec window size in seconds
 */
export function rateLimit(
  id: string,
  action: string,
  limit: number,
  windowSec: number
): { ok: boolean; retryAfter: number; remaining: number } {
  const key = `${action}:${id}`;
  const now = Date.now();
  const entry = _store.get(key);

  if (!entry || now > entry.reset) {
    _store.set(key, { count: 1, reset: now + windowSec * 1000 });
    return { ok: true, retryAfter: 0, remaining: limit - 1 };
  }

  entry.count++;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.reset - now) / 1000);
    return { ok: false, retryAfter, remaining: 0 };
  }

  return { ok: true, retryAfter: 0, remaining: limit - entry.count };
}

/** Get caller IP from Next.js request headers */
export function getClientIp(req: Request): string {
  const headers = req instanceof Request ? req.headers : (req as { headers: Headers }).headers;
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip') ||
    'unknown'
  );
}
