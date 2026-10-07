import { Store } from "lucide-react";
import { BUSINESS_TYPES, PLANS } from "@/lib/platform";
import { Submit } from "../backoffice/busy";
import type { Start } from "../backoffice/table-kit";
import { Empty } from "../backoffice/ui";
import { ago, cap, day, Notes, supportId } from "./bits";
import { Password } from "./password";
import { type TenantLine, TenantsTable } from "./tenants-table";

export type TenantRow = {
  id: string;
  name: string;
  business_type: string;
  plan: string;
  status: string;
  status_reason: string | null;
  created_at: string;
  stores: number;
  logins: number;
  devices: number;
  last_sale: string | null;
};

// The admin's first page as it is drawn: how the restaurants stand, the form
// that makes a new one (above the list, so there is no scrolling to it), and
// the list. The page beside this file reads the rows and holds the action.
export function AdminHome({
  tenants,
  start,
  error,
  notice,
  createTenant,
}: {
  tenants: TenantRow[];
  start: Start;
  error?: string;
  notice?: string;
  createTenant: (f: FormData) => Promise<void>;
}) {
  const now = Date.now();
  const suspended = tenants.filter((t) => t.status !== "active").length;
  const sold = tenants.filter((t) => t.last_sale && now - new Date(t.last_sale).getTime() < 7 * 86400000).length;
  const never = tenants.filter((t) => !t.last_sale).length;
  const stores = tenants.reduce((n, t) => n + t.stores, 0);
  const tills = tenants.reduce((n, t) => n + t.devices, 0);
  const lines: TenantLine[] = tenants.map((t) => ({
    id: t.id,
    code: supportId(t.id),
    name: t.name,
    type: t.business_type,
    plan: t.plan,
    active: t.status === "active",
    reason: t.status_reason,
    stores: t.stores,
    logins: t.logins,
    tills: t.devices,
    lastSale: t.last_sale ? new Date(t.last_sale).getTime() : null,
    lastSaleShown: t.last_sale ? ago(t.last_sale, now) : "",
    created: new Date(t.created_at).getTime(),
    createdShown: day(t.created_at),
  }));
  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>Restaurants</h1>
          <p className="home-status">
            {tenants.length} in total{suspended > 0 ? `, ${suspended} suspended` : ""}.
          </p>
        </div>
        {tenants.length > 0 && (
          <div className="home-side">
            <div className="home-fig">
              <small>Tills</small>
              <strong>{tills}</strong>
              <span>
                in {stores} {stores === 1 ? "store" : "stores"}
              </span>
            </div>
            <div className="home-fig">
              <small>Sold in the last 7 days</small>
              <strong>{sold}</strong>
              <span>{never > 0 ? `${never} never sold` : `of ${tenants.length}`}</span>
            </div>
          </div>
        )}
      </header>
      <Notes error={error} notice={notice} />

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>New restaurant</h2>
            <p>Makes the restaurant, its first store and the owner&apos;s login in one go.</p>
          </div>
        </div>
        <form action={createTenant}>
          <div className="card-body adm-fields">
            <label className="field">
              Restaurant name
              <input name="tenant" required />
            </label>
            <label className="field">
              First store
              <input name="store" defaultValue="Main store" required />
            </label>
            <label className="field">
              Store code
              <input name="code" defaultValue="S1" required />
              <span className="help">1 to 12 letters or digits.</span>
            </label>
            <div className="field">
              Business type
              <div className="seg" role="radiogroup" aria-label="Business type">
                {BUSINESS_TYPES.map((t) => (
                  <label key={t}>
                    <input type="radio" name="type" value={t} defaultChecked={t === "restaurant"} />
                    {cap(t)}
                  </label>
                ))}
              </div>
            </div>
            <label className="field">
              Owner&apos;s name
              <input name="ownerName" required />
            </label>
            <label className="field">
              Owner&apos;s email
              <input name="email" type="email" required autoComplete="off" />
              <span className="help">This is their login.</span>
            </label>
            <div className="field">
              Initial password
              <Password label="Initial password" />
              <span className="help">8 characters or more. You give it to the owner.</span>
            </div>
            <div className="field">
              Plan
              <div className="seg" role="radiogroup" aria-label="Plan">
                {PLANS.map((p) => (
                  <label key={p}>
                    <input type="radio" name="plan" value={p} defaultChecked={p === "standard"} />
                    {cap(p)}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="card-foot">
            <Submit>Create restaurant and owner login</Submit>
          </div>
        </form>
      </section>

      {tenants.length === 0 ? (
        <Empty icon={Store} title="No restaurants yet">
          Create the first one above.
        </Empty>
      ) : (
        <TenantsTable key={[...Object.values(start), error, notice].join("|")} rows={lines} start={start} />
      )}
    </div>
  );
}
