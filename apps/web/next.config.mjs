const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** The browser only talks to this origin. /api is proxied to the backend, so session cookies stay same-origin. */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] }];
  },
};
