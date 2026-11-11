/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.PORTFOLIO_API_ORIGIN || 'http://localhost:4001';

const nextConfig = {
  reactStrictMode: true,
  // Lets a production build (share.sh) live next to the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Same-origin API for public links: /papi/* → API, so only the web port is exposed.
  async rewrites() {
    return [{ source: '/papi/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
};

export default nextConfig;
