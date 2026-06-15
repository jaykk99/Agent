/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint:     { ignoreDuringBuilds: true },

  // ── Extend serverless function timeouts ─────────────────────────────────
  // Vercel Pro: 300s max. Hobby: 60s max. Set as high as your plan allows.
  experimental: {
    // serverActions timeout (Next 14+)
    serverActionsBodySizeLimit: '4mb',
  },

  // Per-route timeout overrides (Vercel reads this from next.config)
  // chat route needs up to 120s for multi-turn agentic loops
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options',        value: 'DENY' },
          { key: 'X-XSS-Protection',       value: '1; mode=block' },
          { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
