/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.PORTFOLIO_API_ORIGIN || 'http://localhost:4001';
// Space-separated origins allowed to embed Orbit (Qlix console). Read at build time.
const FRAME_ANCESTORS = process.env.QLIX_FRAME_ANCESTORS || 'http://localhost:3010';

const nextConfig = {
  reactStrictMode: true,
  // Lets a production build (share.sh) live next to the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Same-origin API for public links: /papi/* → API, so only the web port is exposed.
  async rewrites() {
    return [{ source: '/papi/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
  // Qlix shows Orbit inside its PortfolioOS plugin (an iframe): allow only Qlix's console to frame us.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [{ key: 'Content-Security-Policy', value: `frame-ancestors 'self' ${FRAME_ANCESTORS}` }],
      },
    ];
  },
};

export default nextConfig;
