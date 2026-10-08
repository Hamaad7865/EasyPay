import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The OpenNext adapter's settings for Cloudflare Workers. Bare on purpose:
// the usual thing to set here is a cache for pages that are built once and
// served many times, and the back office has none. Every page depends on who
// is asking, so every page is drawn when it is asked for.
export default defineCloudflareConfig();
