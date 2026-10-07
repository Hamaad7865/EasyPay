import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: __dirname },
  // a catalog of 5,000 rows, sent to the import as one request, is larger than the 1 MB a server action takes by default
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
};

export default config;
