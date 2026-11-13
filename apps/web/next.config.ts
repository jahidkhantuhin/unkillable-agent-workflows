import type { NextConfig } from 'next';
const config: NextConfig = {
  transpilePackages: ['@unkillable/shared'],
  devIndicators: false,
};
export default config;
