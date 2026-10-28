import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";

// A picture of a product or of a variant (migration 0143), for the back
// office's own pages: the business's own only, read as its role. A picture is
// never changed (a new one gets a new id), so the browser keeps it for good.

export const dynamic = "force-dynamic";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) return new Response("Not found", { status: 404 });
  const ctx = await tenantContext();
  const jpeg = await readTenant(ctx.tenantId, async (c) =>
    ((await c.query(`select jpeg from pictures where tenant_id = $1 and id = $2`, [ctx.tenantId, id])).rows[0]?.jpeg as Buffer | undefined) ?? null,
  );
  if (!jpeg) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(jpeg), {
    headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" },
  });
}
