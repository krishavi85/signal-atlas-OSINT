/** @type {import('next').NextConfig} */
const apiOrigin = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Proxy API + SSE through Next so the browser talks to one origin.
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
