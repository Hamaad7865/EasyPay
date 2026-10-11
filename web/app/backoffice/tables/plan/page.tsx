import { redirect } from "next/navigation";

// The plan of one floor used to be a page of its own. It is the Floor plan
// page now, with the areas across its top: an address kept from before (a
// bookmark, the search) lands there.
export default async function FloorPlanMoved({ searchParams }: { searchParams: Promise<{ store?: string; floor?: string }> }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  if (sp.store) q.set("store", sp.store);
  if (sp.floor) q.set("floor", sp.floor);
  const tail = q.toString();
  redirect("/backoffice/tables" + (tail ? "?" + tail : ""));
}
