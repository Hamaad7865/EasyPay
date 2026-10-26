import Link from "next/link";
import { onlyFor } from "@/lib/tenant";
import { ask } from "@/lib/db";
import { PageHead } from "../../ui";
import { importCatalog } from "./actions";
import { type Branch, pickedOf } from "@/lib/branch";
import { BranchPicker } from "../../branch-picker";
import { Importer } from "./importer";

// A shop's catalog from a spreadsheet. The work is the database's
// (catalog_import, migration 0071): this page reads the file in the browser
// (an Excel workbook or a CSV), has its columns said, shows what a run would
// do, and then asks for it.
export default async function ImportPage() {
  const ctx = await onlyFor("retail");
  // a file writes costs, so importing is for someone who may see cost
  const costs = (await ask(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId])).rows[0]?.ok as boolean;
  // opening stock goes to the branch picked here (multi-branch)
  const all = (await ask(`select id, name, address, phone from stores where tenant_id = $1 and deleted_at is null order by created_at, id`, [ctx.tenantId])).rows as Branch[];
  const picked = await pickedOf(all);
  return (
    <div>
      <PageHead
        title="Import products"
        lede="Bring a catalog in from an Excel or a CSV file, your own or a supplier's, or change many products at once: download your products, edit the file, and import it again. A product already there is found by its name; what the file leaves empty is kept. Opening stock is only set on a line that has never moved."
      >
        <BranchPicker all={all} picked={picked?.id ?? null} />
        <Link href="/backoffice/items" className="btn btn-quiet">Back to products</Link>
      </PageHead>
      {all.length > 1 && (
        <p className="note">
          {picked
            ? `Opening stock and reorder levels in the file go to ${picked.name}. Products and prices are the same at every branch.`
            : "Products and prices are the same at every branch. A file with opening stock or reorder levels needs a branch: pick it at the top."}
        </p>
      )}
      {costs ? <Importer run={importCatalog} /> : <p className="note warn">A file carries what each product costs, so importing is for someone who may see cost. Ask the owner to tick See cost and profit on your role.</p>}
    </div>
  );
}
