import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { loadSettings } from "@/lib/settings";
import { PREMIUM_ONLY } from "@/lib/plan";
import { Card, PageHead } from "../../ui";
import { CardsView, type CardStore, type CardTable } from "./view";

// A card for each table of a store, to print, cut out and put on the table.
// Its code is the table's own address at the ordering site (lib/guest.ts): a
// guest who scans it sees the menu the till published and sends their order
// to the till. A page of the premium tier, as ordering from the table is.
export default async function TableCardsPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const sp = await searchParams;
  const ctx = await onlyFor("restaurant");
  if (!ctx.premium) {
    return (
      <div>
        <PageHead title="Table cards" lede="A card for each table, with the code a guest scans to see the menu and order." />
        <Card title={`Ordering from the table is ${PREMIUM_ONLY}`}>
          <p>This restaurant&apos;s plan does not include ordering from the table. Ask EasyPay to switch Premium on.</p>
        </Card>
      </div>
    );
  }
  const data = await readTenant(ctx.tenantId, async (c) => {
    const stores = (await c.query(`select id, name, guest_id from stores where tenant_id = $1 and deleted_at is null order by created_at`, [ctx.tenantId]))
      .rows as CardStore[];
    const store = stores.find((s) => s.id === sp.store) ?? stores[0] ?? null;
    const settings = await loadSettings(c, ctx.tenantId);
    const tables = store
      ? ((await c.query(
          `select id, name, area from tables where tenant_id = $1 and store_id = $2 and deleted_at is null order by area, sort_order, name`,
          [ctx.tenantId, store.id],
        )).rows as CardTable[])
      : [];
    const named = (await c.query(`select name from tenants where id = $1`, [ctx.tenantId])).rows[0]?.name as string | undefined;
    return { stores, store, tables, on: settings.tableOrdering, name: settings.company.name.trim() || named || "" };
  });
  return <CardsView name={data.name} stores={data.stores} store={data.store} tables={data.tables} on={data.on} />;
}
