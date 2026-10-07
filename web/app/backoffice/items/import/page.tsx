import Link from "next/link";
import { onlyFor } from "@/lib/tenant";
import { ask } from "@/lib/db";
import { PageHead } from "../../ui";
import { Importer } from "./importer";

// A shop's catalog from a spreadsheet. The work is the database's
// (catalog_import, migration 0071): this page reads the file in the browser,
// shows what a run would do, and then asks for it.
export default async function ImportPage() {
  const ctx = await onlyFor("retail");
  // a file writes costs, so importing is for someone who may see cost
  const costs = (await ask(`select has_perm($1, 'costs.view') as ok`, [ctx.employeeId])).rows[0]?.ok as boolean;
  return (
    <div>
      <PageHead
        title="Import products"
        lede="Bring a catalog in from a spreadsheet, or change many products at once: download your products, edit the file, and import it again. A product already there is found by its name; what the file leaves empty is kept. Opening stock is only set on a line that has never moved."
      >
        <Link href="/backoffice/items" className="btn btn-quiet">Back to products</Link>
      </PageHead>
      {costs ? <Importer /> : <p className="note warn">A file carries what each product costs, so importing is for someone who may see cost. Ask the owner to tick See cost and profit on your role.</p>}
    </div>
  );
}
