import { auth } from "@/lib/auth/server";

// Why this file is `middleware.ts` and not `proxy.ts`: Next 16 renamed the
// convention to `proxy` and runs it on the Node runtime, and the adapter that
// puts the back office on Cloudflare Workers (OpenNext) refuses that. Under
// the old name it runs where the adapter can take it. Next says the name is
// deprecated when it builds; the file does the same thing under either name.
export default auth.middleware({ loginUrl: "/login" });

// Signed-out visitors are sent to /login. Being signed in is not enough for
// /admin: every admin page and action also checks platform.admins.
export const config = {
  matcher: ["/backoffice/:path*", "/onboarding/:path*", "/admin/:path*"],
};
