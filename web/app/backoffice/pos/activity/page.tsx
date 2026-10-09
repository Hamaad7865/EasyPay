import { redirect } from "next/navigation";
import { movedTo } from "@/lib/pos";
import { type Search, one } from "../../ui";

// Till activity is each till's Traceability tab now. An address kept from
// before goes to the tab of the till it named, on the day it asked for, and
// to the cards when it named none.
export default async function TillActivity({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  redirect(movedTo("activity", { till: one(sp.till) || undefined, day: one(sp.day) || undefined }));
}
