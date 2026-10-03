import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { PLANS, adminMessage, requirePlatformAdmin } from "@/lib/platform";
import { loginForRestaurant, passwordProblem, removeLogin } from "@/lib/platform-auth";

type TenantRow = {
  id: string;
  name: string;
  plan: string;
  status: string;
  status_reason: string | null;
  created_at: string;
  stores: number;
  logins: number;
  devices: number;
  last_sale: string | null;
};

const fail = (message: string): never => redirect(`/admin?error=${encodeURIComponent(message)}`);

// Creates the owner's login (or takes over one that exists for that email and
// belongs to nobody), then the restaurant around it. If the second step fails,
// a login created here is removed again, so the form can simply be resubmitted.
async function createTenant(formData: FormData) {
  "use server";
  const admin = await requirePlatformAdmin();
  const text = (key: string) => String(formData.get(key) ?? "").trim();
  const name = text("tenant");
  const store = text("store") || "Main store";
  const code = (text("code") || "S1").toUpperCase();
  const ownerName = text("ownerName");
  const email = text("email").toLowerCase();
  const plan = text("plan") || "standard";
  const password = String(formData.get("password") ?? "");

  if (!name) fail("Give the restaurant a name.");
  if (!ownerName) fail("Give the owner's name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("That email address does not look right.");
  if (!/^[A-Z0-9]{1,12}$/.test(code)) fail("Store code must be 1 to 12 letters or digits.");
  const weak = passwordProblem(password);
  if (weak) fail(weak);

  const login = await loginForRestaurant({ email, password, name: ownerName });
  if (!login.ok) fail(login.message);
  const { userId, created } = login as { userId: string; created: boolean };

  let tenantId = "";
  try {
    const made = await db().query(`select platform.create_tenant($1, $2, $3, $4, $5, $6, $7) as r`, [
      admin.userId,
      name,
      store,
      code,
      ownerName,
      userId,
      plan,
    ]);
    tenantId = made.rows[0].r.tenant_id as string;
  } catch (e) {
    if (created) await removeLogin(userId);
    fail(adminMessage(e));
  }
  revalidatePath("/admin");
  // no email or password in the URL: it ends up in history and logs
  redirect(`/admin/tenants/${tenantId}?notice=${encodeURIComponent(
      created
        ? "Restaurant created. Give the owner their password."
        : "Restaurant created. That email already had a login: it is now the owner, with the password you typed.",
    )}`);
}

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const tenants = await db()
    .query(
      `select t.id, t.name, t.plan, t.status, t.status_reason, t.created_at,
              (select count(*)::int from stores s where s.tenant_id = t.id and s.deleted_at is null) as stores,
              (select count(*)::int from employees e
                where e.tenant_id = t.id and e.auth_user_id is not null and e.deleted_at is null) as logins,
              (select count(*)::int from pos_devices d where d.tenant_id = t.id and d.deleted_at is null) as devices,
              (select max(r.created_at) from receipts r where r.tenant_id = t.id) as last_sale
         from tenants t
        where t.deleted_at is null
        order by t.created_at desc`,
    )
    .then((r) => r.rows as TenantRow[]);
  const suspended = tenants.filter((t) => t.status !== "active").length;
  return (
    <div>
      <h1>Restaurants</h1>
      {sp.error && <p style={{ color: "#8a1c1c" }}>{sp.error}</p>}
      {sp.notice && <p style={{ color: "#1c6b2a" }}>{sp.notice}</p>}
      <p>
        {tenants.length} in total{suspended > 0 ? `, ${suspended} suspended` : ""}.
      </p>

      <h2>New restaurant</h2>
      <form action={createTenant} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
        <input name="tenant" placeholder="Restaurant name" required />
        <input name="store" placeholder="First store" defaultValue="Main store" required />
        <input name="code" placeholder="Store code" defaultValue="S1" required />
        <input name="ownerName" placeholder="Owner's name" required />
        <input name="email" type="email" placeholder="Owner's email (their login)" required autoComplete="off" />
        <input
          name="password"
          type="password"
          placeholder="Initial password (8 characters or more)"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <select name="plan" defaultValue="standard">
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="submit">Create restaurant and owner login</button>
      </form>

      <h2>All restaurants</h2>
      <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th>Restaurant</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Stores</th>
            <th>Logins</th>
            <th>Tills</th>
            <th>Last sale</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id} style={{ borderBottom: "1px solid #eee" }}>
              <td>
                <Link href={`/admin/tenants/${t.id}`}>{t.name}</Link>
              </td>
              <td>{t.plan}</td>
              <td style={{ color: t.status === "active" ? undefined : "#8a1c1c" }}>
                {t.status}
                {t.status_reason ? ` (${t.status_reason})` : ""}
              </td>
              <td>{t.stores}</td>
              <td>{t.logins}</td>
              <td>{t.devices}</td>
              <td>{t.last_sale ? new Date(t.last_sale).toLocaleDateString() : "never"}</td>
              <td>{new Date(t.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tenants.length === 0 && <p>No restaurants yet. Create the first one above.</p>}
    </div>
  );
}
