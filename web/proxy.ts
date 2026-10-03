import { auth } from "@/lib/auth/server";

export default auth.middleware({ loginUrl: "/login" });

// Signed-out visitors are sent to /login. Being signed in is not enough for
// /admin: every admin page and action also checks platform.admins.
export const config = {
  matcher: ["/backoffice/:path*", "/onboarding/:path*", "/admin/:path*"],
};
