import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text } from "@/lib/action";
import { loadSettings, saveSettings } from "@/lib/settings";
import { Card, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

const PATH = "/backoffice/company";

// The details that print at the top of every receipt and bill.
async function save(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const name = text(f, "name", 80);
    if (!name) throw new Refused("The business needs a name.");
    const company = { name, brn: text(f, "brn", 30), vat: text(f, "vat", 30), address: text(f, "address", 240), phone: text(f, "phone", 40) };
    await c.query(`update tenants set name = $2, brn = $3, vat_number = $4 where id = $1`, [
      ctx.tenantId,
      name,
      company.brn || null,
      company.vat || null,
    ]);
    await saveSettings(c, ctx.tenantId, { company });
    return "Company details saved. They print on receipts from the next sync.";
  });
}

export default async function CompanyPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const d = await readTenant(ctx.tenantId, async (c) => {
    const t = (await c.query(`select name, brn, vat_number from tenants where id = $1`, [ctx.tenantId])).rows[0] as {
      name: string;
      brn: string | null;
      vat_number: string | null;
    };
    const s = await loadSettings(c, ctx.tenantId);
    return { name: t.name, brn: t.brn ?? s.company.brn, vat: t.vat_number ?? s.company.vat, address: s.company.address, phone: s.company.phone };
  });
  return (
    <div>
      <PageHead title="Company details" lede="Who the restaurant is on paper. These print at the top of every receipt, bill and closing report." />
      <Flash sp={sp} />
      <form action={save}>
        <Card title="Business">
          <label className="field">
            Business name
            <input name="name" defaultValue={d.name} required maxLength={80} />
          </label>
          <div className="form-row" style={{ maxWidth: 640 }}>
            <label className="field">
              BRN
              <input name="brn" defaultValue={d.brn} maxLength={30} placeholder="C12345678" />
              <span className="help">Business Registration Number.</span>
            </label>
            <label className="field">
              VAT number
              <input name="vat" defaultValue={d.vat} maxLength={30} placeholder="VAT27000000" />
              <span className="help">Leave empty if the business is not VAT registered.</span>
            </label>
          </div>
          <label className="field" style={{ maxWidth: 640 }}>
            Address
            <textarea name="address" defaultValue={d.address} maxLength={240} rows={3} placeholder={"Royal Road\nCurepipe"} />
          </label>
          <label className="field">
            Phone
            <input name="phone" defaultValue={d.phone} maxLength={40} placeholder="5 123 4567" />
          </label>
        </Card>
        <Submit>Save details</Submit>
      </form>
    </div>
  );
}
