import { redirect } from "next/navigation";

// Point of sale opens on its first page.
export default function Pos() {
  redirect("/backoffice/pos/tills");
}
