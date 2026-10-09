import { redirect } from "next/navigation";
import { movedTo } from "@/lib/pos";

// Tills is the cards of Point of sale now. An address kept from before goes there.
export default function Tills() {
  redirect(movedTo("tills", {}));
}
