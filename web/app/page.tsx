import { redirect } from "next/navigation";
import { platformAdminOrNull } from "@/lib/platform";

// reads the session cookie, so it is never prerendered
export const dynamic = "force-dynamic";

// One front door: the platform admin lands in the admin area, everyone else in
// their restaurant's back office (which sends a signed-out visitor to /login).
export default async function Home() {
  if (await platformAdminOrNull()) redirect("/admin");
  redirect("/backoffice");
}
