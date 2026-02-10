import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["unzipper"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "m.media-amazon.com",
      },
      {
        protocol: "https",
        hostname: "image.tmdb.org",
      },
    ],
  },
};

export default nextConfig;
