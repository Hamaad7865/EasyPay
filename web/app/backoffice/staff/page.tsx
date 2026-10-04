import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { requirePerm, tenantContext } from "@/lib/tenant";
import { withTenant } from "@/lib/db";
import { hashPin, isPin } from "@/lib/pin";

type Staff = {
  id: string;
  name: string;
  role: string | null;
  has_pin: boolean;
  has_login: boolean;
  is_active: boolean;
};

// Messages only: a PIN never goes in a URL.
function back(kind: "notice" | "error", message: string): never {
  redirect(`/backoffice/staff?${kind}=${encodeURIComponent(message)}`);
}

async function guard() {
  try {
    return await requirePerm("employees.edit");
  } catch (e) {
    unstable_rethrow(e); // a redirect to /login is not an error to report
    back("error", e instanceof Error ? e.message : "Not allowed.");
  }
}

async function addStaff(formData: FormData) {
  "use server";
  const ctx = await guard();
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const pin = String(formData.get("pin") ?? "");
  if (!name) back("error", "Give the member of staff a name.");
  if (!isPin(pin)) back("error", "A PIN is 4 digits.");
  const added = await withTenant(ctx.tenantId, async (c) => {
    const r = await c.query(`select id from roles where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, role]);
    if (r.rowCount !== 1) return false;
    // works at every store of the restaurant
    await c.query(
      `with e as (insert into employees (tenant_id, name, role_id, pin_hash) values ($1, $2, $3, $4) returning id)
       insert into employee_stores (tenant_id, employee_id, store_id)
         select $1, e.id, s.id from e, stores s where s.tenant_id = $1 and s.deleted_at is null`,
      [ctx.tenantId, name, role, hashPin(pin)],
    );
    return true;
  });
  if (!added) back("error", "Pick a role.");
  revalidatePath("/backoffice/staff");
  back("notice", `${name} added. The tills get the change at their next sync.`);
}

async function setPin(formData: FormData) {
  "use server";
  const ctx = await guard();
  const id = String(formData.get("id") ?? "");
  const pin = String(formData.get("pin") ?? "");
  if (!isPin(pin)) back("error", "A PIN is 4 digits.");
  const name = await withTenant(ctx.tenantId, (c) =>
    c
      .query(`update employees set pin_hash = $3 where tenant_id = $1 and id = $2 and deleted_at is null returning name`, [
        ctx.tenantId,
        id,
        hashPin(pin),
      ])
      .then((r) => (r.rows[0]?.name as string | undefined) ?? null),
  );
  if (!name) back("error", "That member of staff was not found.");
  revalidatePath("/backoffice/staff");
  back("notice", `PIN set for ${name}. The tills get it at their next sync.`);
}

// Only staff who have no login of their own: a login is switched on and off by
// RestoPOS, and switching off your own would lock you out of this page.
async function setActive(formData: FormData) {
  "use server";
  const ctx = await guard();
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "1";
  const name = await withTenant(ctx.tenantId, (c) =>
    c
      .query(
        `update employees set is_active = $3
          where tenant_id = $1 and id = $2 and deleted_at is null and auth_user_id is null returning name`,
        [ctx.tenantId, id, active],
      )
      .then((r) => (r.rows[0]?.name as string | undefined) ?? null),
  );
  if (!name) back("error", "That member of staff cannot be changed here.");
  revalidatePath("/backoffice/staff");
  back("notice", active ? `${name} can use the tills again.` : `${name} can no longer sign in at the tills.`);
}

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  const data = await withTenant(ctx.tenantId, async (c) => {
    const staff = await c.query(
      `select e.id, e.name, r.name as role, e.pin_hash is not null as has_pin,
              e.auth_user_id is not null as has_login, e.is_active
         from employees e left join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id
        where e.tenant_id = $1 and e.deleted_at is null
        order by e.is_active desc, e.name`,
      [ctx.tenantId],
    );
    const roles = await c.query(`select id, name from roles where tenant_id = $1 and deleted_at is null order by name`, [ctx.tenantId]);
    const may = await c.query(`select has_perm($1, 'employees.edit') as ok`, [ctx.employeeId]);
    return {
      staff: staff.rows as Staff[],
      roles: roles.rows as { id: string; name: string }[],
      may: Boolean(may.rows[0]?.ok),
    };
  });
  const withPin = data.staff.filter((s) => s.is_active && s.has_pin).length;
  const pinInput = (label: string) => (
    <input
      name="pin"
      type="password"
      inputMode="numeric"
      pattern="\d{4}"
      maxLength={4}
      autoComplete="off"
      placeholder="PIN"
      required
      size={6}
      aria-label={label}
    />
  );
  return (
    <div>
      <h1>Staff</h1>
      {sp.notice && (
        <div className="bo-banner">
          <strong>{sp.notice}</strong>
        </div>
      )}
      {sp.error && (
        <div className="bo-banner danger">
          <strong>{sp.error}</strong>
        </div>
      )}
      <div className={withPin === 0 ? "bo-banner warn" : "bo-banner"}>
        <strong>
          {withPin === 0 ? "No one has a PIN yet." : `${withPin} ${withPin === 1 ? "person has" : "people have"} a PIN.`}
        </strong>
        {withPin === 0
          ? "Until someone does, the tills open without asking who is selling, and every sale is recorded under the login the till was set up with. Give yourself a PIN first."
          : "At the till, staff clock in with their PIN, and each sale is recorded under the person who rang it up. Someone without a PIN cannot use the till."}
      </div>
      {data.may ? (
        <form action={addStaff} className="bo-toolbar">
          <input name="name" placeholder="Name" required maxLength={60} />
          <select name="role" defaultValue={data.roles.find((r) => r.name === "Cashier")?.id ?? ""} aria-label="Role">
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {pinInput("PIN for the new member of staff")}
          <button type="submit">Add staff</button>
        </form>
      ) : (
        <p className="muted">Only the owner can add staff or change PINs.</p>
      )}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>PIN</th>
            <th>Back office login</th>
            <th>At the tills</th>
            {data.may && <th>Change</th>}
          </tr>
        </thead>
        <tbody>
          {data.staff.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.role ?? "none"}</td>
              <td>{s.has_pin ? "Set" : <span className="flag">Not set</span>}</td>
              <td>{s.has_login ? "Yes" : "No"}</td>
              <td>{s.is_active ? "Active" : <span className="muted">Switched off</span>}</td>
              {data.may && (
                <td>
                  <div className="bo-toolbar" style={{ margin: 0 }}>
                    <form action={setPin} className="bo-toolbar" style={{ margin: 0 }}>
                      <input type="hidden" name="id" value={s.id} />
                      {pinInput(`New PIN for ${s.name}`)}
                      <button type="submit" className="btn-quiet">
                        {s.has_pin ? "Change PIN" : "Set PIN"}
                      </button>
                    </form>
                    {!s.has_login && (
                      <form action={setActive}>
                        <input type="hidden" name="id" value={s.id} />
                        <input type="hidden" name="active" value={s.is_active ? "0" : "1"} />
                        <button type="submit" className="btn-quiet">
                          {s.is_active ? "Switch off" : "Switch on"}
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
