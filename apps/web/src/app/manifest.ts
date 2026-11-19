import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Unkillable Approvals',
    short_name: 'Unkillable',
    description: 'Review durable workflow approvals with human control.',
    start_url: '/approvals',
    scope: '/',
    display: 'standalone',
    background_color: '#0b100e',
    theme_color: '#0b100e',
    icons: [
      {
        src: '/icons/app-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/app-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
