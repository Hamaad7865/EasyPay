import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: __dirname },
  // a catalog of 5,000 rows, sent to the import as one request, is larger than the 1 MB a server action takes by default
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
  // For the Cloudflare build only; it changes nothing on a Node server. The database driver opens its
  // connection through this package there, and the package keeps that code behind a "workerd" export that
  // Next does not follow: only its empty stand-in is copied, and the build stops at "Could not resolve
  // pg-cloudflare". Named here, the adapter copies the package whole.
  serverExternalPackages: ["pg-cloudflare"],
};

export default config;
