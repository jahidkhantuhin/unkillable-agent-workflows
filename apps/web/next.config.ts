import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@unkillable/shared'],
  devIndicators: false,
  allowedDevOrigins: process.env.WEB_PUBLIC_URL
    ? [new URL(process.env.WEB_PUBLIC_URL).hostname]
    : [],
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/approve',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};
export default config;
