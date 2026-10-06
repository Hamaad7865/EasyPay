import { redirect } from "next/navigation";
import { one, type Search } from "../../ui";

// "Sales periods" used to be a report of its own. A sales period and a day
// are one thing now (a day on a till, from its opening count to its closing
// count), so an old link or a bookmark to here is sent to Day closing, with
// its dates.
export default async function ShiftReport({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const q = [["from", one(sp.from)], ["to", one(sp.to)]].filter(([, v]) => day.test(v)).map(([k, v]) => `${k}=${v}`).join("&");
  redirect(`/backoffice/reports/day-close${q ? `?${q}` : ""}`);
}
