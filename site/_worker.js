// The front door of easypaypos.com.
//
// This folder is the public site, served as it is. The back office (sign-in,
// the pages behind it, the admin area) is a separate Worker, `web/` built for
// Cloudflare; this file hands its addresses to it over a service binding
// (BACKOFFICE, see cloudflare/pages/wrangler.toml), so the two are one site:
// easypaypos.com is the site and easypaypos.com/login the sign-in.
//
// The request goes on untouched, address and all: the back office checks that
// a form was sent from the address it is served at, and sets its sign-in
// cookie for that address.
//
// _routes.json beside this file lists the same addresses, so that a visit to
// the public site never runs this at all.
const BACK_OFFICE = [
  "/login", "/reset-password", "/onboarding", "/backoffice", "/admin", "/api/auth", // its pages and its sign-in calls
  "/_next", // its scripts and styles
];
const BACK_OFFICE_FILES = ["/icon.png", "/logo-full.png", "/logo-mark.png"]; // web/app/icon.png and web/public

const isBackOffice = (path) => BACK_OFFICE_FILES.includes(path) || BACK_OFFICE.some((p) => path === p || path.startsWith(p + "/"));

// The back office has one address. A sign-in is kept for the address it was
// made at, and the sign-in service refuses one made from an address it does
// not know ("invalid origin"): at www.easypaypos.com the sign-in page opened
// and then refused everyone. So the back office asked for at www is sent to
// the same page without it. The public site itself answers at both.
const HOME = "easypaypos.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (!isBackOffice(pathname)) return env.ASSETS.fetch(request);
    if (url.hostname === "www." + HOME) {
      url.hostname = HOME;
      // 308: the same request, method and all, at the other address
      return Response.redirect(url.toString(), 308);
    }
    if (!env.BACKOFFICE) {
      return new Response("EasyPay's back office is not switched on yet.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-easypay": "front-door-without-back-office" },
      });
    }
    return env.BACKOFFICE.fetch(request);
  },
};
