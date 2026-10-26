import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, Refused, text } from "@/lib/action";
import { loadSettings, saveSettings } from "@/lib/settings";
import { asNature, checklistWords, NATURES, onMra, type ChecklistLine } from "@/lib/mra";
import { Card, Flash, PageHead, type Search } from "../ui";
import { Submit } from "../busy";

const PATH = "/backoffice/company";

// The details that print at the top of every receipt and bill. A client on
// Premium MRA also gives what the MRA asks for with every sale (0116): its
// legal name, TAN, what it sells, and an address for each branch.
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
    // each branch's own name, address and phone, when there are two or more (multi-branch): what its tills print at
    // the top of their papers, and the address the MRA receives with its sales
    const stores = (await c.query(`select id from stores where tenant_id = $1 and deleted_at is null`, [ctx.tenantId])).rows as { id: string }[];
    if (stores.length > 1) {
      for (const s of stores) {
        if (!f.has("name_" + s.id)) continue;
        const branch = text(f, "name_" + s.id, 80);
        if (!branch) throw new Refused("Each branch needs a name.");
        await c.query(`update stores set name = $3, address = $4, phone = $5 where tenant_id = $1 and id = $2`, [
          ctx.tenantId, s.id, branch, text(f, "addr_" + s.id, 240) || null, text(f, "phone_" + s.id, 40) || null,
        ]);
      }
    }
    if (!onMra(ctx.mra)) return "Company details saved. They print on receipts from the next sync.";
    const tan = text(f, "tan", 20);
    if (tan && !/^\d{6,12}$/.test(tan)) throw new Refused("A TAN is made of digits only, as on the MRA's letters.");
    await c.query(`update tenants set legal_name = $2, tan = $3, mra_nature = $4 where id = $1`, [
      ctx.tenantId,
      text(f, "legal_name", 100) || null,
      tan || null,
      asNature(f.get("mra_nature")),
    ]);
    // what the tills put on every invoice they send the MRA (0132)
    await saveSettings(c, ctx.tenantId, {
      mra_seller: { legal_name: text(f, "legal_name", 100), tan, nature: asNature(f.get("mra_nature")) ?? "" },
    });
    // with one branch the company's address is that branch's; with more, each has its own (saved above)
    if (stores.length === 1) await c.query(`update stores set address = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, stores[0].id, company.address || null]);
    return "Company details saved, with what the MRA asks for. They print on receipts from the next sync.";
  });
}

type Branch = { id: string; name: string; address: string | null; phone: string | null };

export default async function CompanyPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const mra = onMra(ctx.mra);
  const d = await readTenant(ctx.tenantId, async (c) => {
    const t = (await c.query(`select name, brn, vat_number, legal_name, tan, mra_nature from tenants where id = $1`, [ctx.tenantId])).rows[0] as {
      name: string;
      brn: string | null;
      vat_number: string | null;
      legal_name: string | null;
      tan: string | null;
      mra_nature: string | null;
    };
    const s = await loadSettings(c, ctx.tenantId);
    const branches = (await c.query(`select id, name, address, phone from stores where tenant_id = $1 and deleted_at is null order by created_at, id`, [ctx.tenantId])).rows as Branch[];
    const checklist = mra ? ((await c.query(`select mra_checklist($1) as r`, [ctx.tenantId])).rows[0].r as ChecklistLine[]) : [];
    return {
      name: t.name,
      brn: t.brn ?? s.company.brn,
      vat: t.vat_number ?? s.company.vat,
      address: s.company.address,
      phone: s.company.phone,
      legalName: t.legal_name ?? "",
      tan: t.tan ?? "",
      nature: t.mra_nature ?? "",
      branches,
      checklist,
    };
  });
  const lines = checklistWords(d.checklist);
  return (
    <div>
      <PageHead
        title="Company details"
        lede={
          ctx.mode === "retail"
            ? "Who the shop is on paper. These print at the top of every receipt and closing report."
            : "Who the restaurant is on paper. These print at the top of every receipt, bill and closing report."
        }
      />
      <Flash sp={sp} />
      {mra && (
        <Card title="Moving to the MRA">
          <p className="muted" style={{ marginTop: 0 }}>
            This business is moving to Premium MRA: from the day it goes live, every sale is sent to the MRA. What the move still needs:
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {lines.map((l) => (
              <li key={l.key}>
                <span className={l.ok ? "badge green" : "badge amber"}>{l.ok ? "Done" : "To do"}</span> {l.title}
                {l.detail && <span className="muted"> · {l.detail}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <form action={save}>
        <Card title="Business">
          <label className="field">
            Business name
            <input name="name" defaultValue={d.name} required maxLength={80} />
          </label>
          {mra && (
            <label className="field" style={{ maxWidth: 640 }}>
              Legal name
              <input name="legal_name" defaultValue={d.legalName} maxLength={100} placeholder="Le Gourmet Ltd" />
              <span className="help">As registered. The MRA receives it with every sale.</span>
            </label>
          )}
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
          {mra && (
            <div className="form-row" style={{ maxWidth: 640 }}>
              <label className="field">
                TAN
                <input name="tan" defaultValue={d.tan} maxLength={12} inputMode="numeric" placeholder="12345678" />
                <span className="help">The business&apos;s Tax Account Number with the MRA.</span>
              </label>
              <label className="field">
                What you sell
                <select name="mra_nature" defaultValue={d.nature}>
                  <option value="">Choose</option>
                  {NATURES.map(([v, words]) => (
                    <option key={v} value={v}>
                      {words}
                    </option>
                  ))}
                </select>
                <span className="help">Said of every line sent to the MRA. A category can say otherwise.</span>
              </label>
            </div>
          )}
          <label className="field" style={{ maxWidth: 640 }}>
            Address
            <textarea name="address" defaultValue={d.address} maxLength={240} rows={3} placeholder={"Royal Road\nCurepipe"} />
          </label>
          <label className="field">
            Phone
            <input name="phone" defaultValue={d.phone} maxLength={40} placeholder="5 123 4567" />
          </label>
        </Card>
        {d.branches.length > 1 && (
          <Card title="Branches">
            <p className="muted" style={{ marginTop: 0 }}>
              Each branch&apos;s name, address and phone print at the top of its own receipts and papers, under the business name. A branch with no
              address or phone of its own prints the business&apos;s.{mra ? " The MRA receives each branch's address with the sales made there." : ""}
            </p>
            {d.branches.map((b) => (
              <div key={b.id} className="form-row" style={{ maxWidth: 900 }}>
                <label className="field">
                  Branch name
                  <input name={"name_" + b.id} defaultValue={b.name} required maxLength={80} />
                </label>
                <label className="field">
                  Address
                  <textarea name={"addr_" + b.id} defaultValue={b.address ?? ""} maxLength={240} rows={2} />
                </label>
                <label className="field">
                  Phone
                  <input name={"phone_" + b.id} defaultValue={b.phone ?? ""} maxLength={40} />
                </label>
              </div>
            ))}
          </Card>
        )}
        <Submit>Save details</Submit>
      </form>
    </div>
  );
}
