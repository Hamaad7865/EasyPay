import { redirect } from "next/navigation";
import { UUID } from "@/lib/action";
import { one, type Search } from "../../ui";

// An item used to be edited on this page. It is now a panel that slides in
// over the list of items, so an old link or a bookmark to here is sent there
// with the panel open: on that item, or on a new one.
export default async function ItemEditPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const id = one(sp.id);
  const category = one(sp.category);
  redirect(`/backoffice/items?${UUID.test(category) ? `category=${category}&` : ""}edit=${UUID.test(id) ? id : "new"}`);
}
