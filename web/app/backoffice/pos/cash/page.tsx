import { redirect } from "next/navigation";
import { movedTo } from "@/lib/pos";
import { type Search, one } from "../../ui";

// Cash flow is each till's Cash flow tab now. An address kept from before
// goes to the tab of the till it named, and to the cards when it named none.
export default async function CashFlow({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  redirect(movedTo("cash", { till: one(sp.till) || undefined }));
}
