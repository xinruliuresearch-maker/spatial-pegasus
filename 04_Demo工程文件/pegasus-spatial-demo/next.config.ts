import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // ali-oss is a Node-only storage client. Keeping it external also avoids
  // Turbopack eagerly resolving urllib's optional proxy-agent lazy import;
  // proxy support is not enabled by this application.
  serverExternalPackages: ['ali-oss'],
  // Standalone output trims ~500MB image down to ~150MB by bundling only the
  // node_modules actually imported at runtime. The Dockerfile COPYs from
  // .next/standalone/ instead of the whole project.
  output: 'standalone',
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
};

export default nextConfig;
