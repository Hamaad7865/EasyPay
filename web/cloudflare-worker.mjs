// What Cloudflare runs: the back office as the OpenNext adapter built it
// (.open-next/worker.js, made by `npm run cf:build`), behind one question.
//
// The back office needs three settings that are kept on the Worker and never
// in the repository (see wrangler.toml). Without one of them every page would
// stop with an error that says nothing. So until all three are there it says,
// in words, that it is not switched on.
import handler from "./.open-next/worker.js";

const NEEDED = ["DATABASE_URL", "NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET"];

export default {
  async fetch(request, env, ctx) {
    const missing = NEEDED.filter((name) => !env[name]);
    if (missing.length > 0) {
      // which ones, for whoever reads the Worker's log; never their values
      console.warn("back office not switched on: missing " + missing.join(", "));
      return new Response("EasyPay's back office is not switched on yet.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-easypay": "back-office-without-settings" },
      });
    }
    return handler.fetch(request, env, ctx);
  },
};
