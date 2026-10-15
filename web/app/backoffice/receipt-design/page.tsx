import Link from "next/link";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, on, Refused } from "@/lib/action";
import { loadSettings, savePaper, saveSettings } from "@/lib/settings";
import { MOST, compact, readDesign, type PaperKind } from "@/lib/papers";
import { Flash, PageHead, type Search } from "../ui";
import { Designer } from "./designer";

const PATH = "/backoffice/receipt-design";

// A design as the page sent it, read as a till reads it: one a till would not
// print (not a design, a locked block missing or hidden) is refused, and what
// is kept is only what differs from EasyPay's settings for each block.
function design(f: FormData, paper: PaperKind, shop: boolean) {
  let raw: unknown;
  try {
    raw = JSON.parse(String(f.get("design") ?? ""));
  } catch {
    throw new Refused("This design could not be read. Reload the page and try again.");
  }
  const blocks = (raw as { blocks?: unknown })?.blocks;
  if (Array.isArray(blocks) && blocks.length > MOST) throw new Refused(`A paper holds at most ${MOST} blocks. Remove some and save again.`);
  const read = readDesign(paper, raw, shop);
  if (read.fellBack || raw == null) throw new Refused("This design could not be read. Reload the page and try again.");
  return compact(paper, read.design);
}

async function saveReceipt(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const kept = design(f, "receipt", ctx.mode === "retail");
    const logo = String(f.get("logo") ?? "");
    if (logo && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new Refused("That logo could not be read. Pick the image again.");
    if (logo.length > 400_000) throw new Refused("That logo is too large. Use a smaller image.");
    // the logo and the two notes stay where the tablets read and write them
    await saveSettings(c, ctx.tenantId, {
      receipt: {
        header: String(f.get("header") ?? "").replace(/\r/g, "").slice(0, 300),
        footer: String(f.get("footer") ?? "").replace(/\r/g, "").slice(0, 300),
        logo: logo || null,
        showLogo: on(f, "showLogo"),
      },
    });
    await savePaper(c, ctx.tenantId, "receipt", kept);
    return "Receipt design saved. The tills print it from their next sync.";
  });
}

async function saveKitchen(f: FormData) {
  "use server";
  await act(
    "settings.device",
    PATH + "?paper=kitchen",
    async (c, ctx) => {
      if (ctx.mode === "retail") throw new Refused("A shop has no kitchen ticket.");
      await savePaper(c, ctx.tenantId, "kitchen", design(f, "kitchen", false));
      return "Kitchen ticket design saved. The tills print it from their next sync.";
    },
  );
}

async function backToEasyPay(f: FormData) {
  "use server";
  const paper: PaperKind = f.get("paper") === "kitchen" ? "kitchen" : "receipt";
  await act("settings.device", PATH + (paper === "kitchen" ? "?paper=kitchen" : ""), async (c, ctx) => {
    await savePaper(c, ctx.tenantId, paper, null);
    return "Back to EasyPay's design. The tills print it from their next sync.";
  });
}

export default async function ReceiptDesignPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const shop = ctx.mode === "retail";
  const paper: PaperKind = sp.paper === "kitchen" && !shop ? "kitchen" : "receipt";
  const d = await readTenant(ctx.tenantId, async (c) => {
    const s = await loadSettings(c, ctx.tenantId);
    const t = (await c.query(`select name, brn, vat_number from tenants where id = $1`, [ctx.tenantId])).rows[0];
    const may = (await c.query(`select has_perm($1, 'settings.device') as ok`, [ctx.employeeId])).rows[0]?.ok as boolean;
    return { s, company: { ...s.company, name: s.company.name || (t?.name ?? ""), brn: s.company.brn || (t?.brn ?? ""), vat: s.company.vat || (t?.vat_number ?? "") }, may };
  });
  const raw = d.s.papers[paper];
  const read = readDesign(paper, raw, shop);
  return (
    <div>
      <PageHead
        title="Receipt design"
        lede="Put the blocks in the order they print, hide what you do not want and set each one's size and style. The preview shows it on 80 mm and 58 mm paper."
      />
      <Flash sp={sp} />
      {!shop && (
        <div className="tabs">
          <Link href={PATH} className={paper === "receipt" ? "on" : ""}>
            Receipt and bill
          </Link>
          <Link href={PATH + "?paper=kitchen"} className={paper === "kitchen" ? "on" : ""}>
            Kitchen ticket
          </Link>
        </div>
      )}
      <Designer
        key={paper}
        paper={paper}
        shop={shop}
        initial={read.design}
        own={raw !== undefined && raw !== null && !read.fellBack}
        unreadable={read.fellBack}
        receipt={d.s.receipt}
        company={d.company}
        decimals={d.s.decimals}
        canEdit={d.may && ctx.status === "active"}
        save={paper === "kitchen" ? saveKitchen : saveReceipt}
        reset={backToEasyPay}
        now={Date.now()}
      />
    </div>
  );
}
