import { tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { act, on, Refused } from "@/lib/action";
import { loadSettings, saveSettings } from "@/lib/settings";
import { Flash, PageHead, type Search } from "../ui";
import { ReceiptForm } from "./receipt-form";

const PATH = "/backoffice/receipt-design";

async function save(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const logo = String(f.get("logo") ?? "");
    if (logo && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new Refused("That logo could not be read. Pick the image again.");
    if (logo.length > 400_000) throw new Refused("That logo is too large. Use a smaller image.");
    await saveSettings(c, ctx.tenantId, {
      receipt: {
        header: String(f.get("header") ?? "").replace(/\r/g, "").slice(0, 300),
        footer: String(f.get("footer") ?? "").replace(/\r/g, "").slice(0, 300),
        logo: logo || null,
        showLogo: on(f, "showLogo"),
      },
    });
    return "Receipt design saved. The tills use it from their next sync.";
  });
}

export default async function ReceiptDesignPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await withTenant(ctx.tenantId, async (c) => {
    const s = await loadSettings(c, ctx.tenantId);
    const t = (await c.query(`select name, brn, vat_number from tenants where id = $1`, [ctx.tenantId])).rows[0];
    const may = (await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId])).rows[0]?.ok as boolean;
    return { s, company: { ...s.company, name: s.company.name || (t?.name ?? ""), brn: s.company.brn || (t?.brn ?? ""), vat: s.company.vat || (t?.vat_number ?? "") }, may };
  });
  return (
    <div>
      <PageHead title="Receipt design" lede="The logo and the notes on the guest's receipt and bill. The preview shows how it comes out on 58 mm and 80 mm paper." />
      <Flash sp={sp} />
      <ReceiptForm action={save} initial={d.s.receipt} company={d.company} canEdit={d.may && ctx.status === "active"} />
    </div>
  );
}
