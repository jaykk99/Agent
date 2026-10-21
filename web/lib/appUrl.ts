/**
 * web/lib/appUrl.ts — the app's own public base URL (used as the OAuth redirect base).
 *
 * APP_URL is the current name. NEXTAUTH_URL is kept as a fallback so existing
 * deployments don't break, and VERCEL_URL last for legacy hosts.
 * Nothing here is Vercel-specific: set APP_URL to your Render URL.
 */
export function appUrl(): string {
  const fromEnv = process.env.APP_URL || process.env.NEXTAUTH_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}
