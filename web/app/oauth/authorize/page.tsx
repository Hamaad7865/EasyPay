import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { hasPremium } from "@/lib/plan";
import { allow, type Ask, checkAsk, OAuthError } from "@/lib/assistant/oauth";
import { AuthCard } from "../../login/auth-card";

// The page Claude opens to connect (spec Q2, Q26): sign in with the back
// office login, then Allow. It says which business, who, and what Claude will
// be able to do. Only a login whose role holds Use the assistant, of a
// business on Premium or the trial, gets an Allow button.

type Sp = Record<string, string | string[] | undefined>;
const query = (sp: Sp) => new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v[0] : v]])));

type Me = { tenantId: string; employeeId: string; tenant: string; name: string; premium: boolean; may: boolean };
async function me(userId: string): Promise<Me | null> {
  const r = await db().query(
    `select e.id, e.tenant_id, e.name, t.name as tenant, t.plan, has_perm(e.id, 'assistant.use') as may
       from employees e join tenants t on t.id = e.tenant_id
      where e.auth_user_id = $1 and e.deleted_at is null and e.is_active`,
    [userId],
  );
  if (r.rowCount !== 1) return null;
  const x = r.rows[0];
  return { tenantId: x.tenant_id, employeeId: x.id, tenant: x.tenant ?? "", name: x.name ?? "", premium: hasPremium(x.plan), may: Boolean(x.may) };
}

async function decide(f: FormData) {
  "use server";
  const q = new URLSearchParams(String(f.get("q") ?? ""));
  const a = await checkAsk(q);
  if (f.get("no") === "1") {
    const to = new URL(a.redirect_uri);
    to.searchParams.set("error", "access_denied");
    if (a.state) to.searchParams.set("state", a.state);
    redirect(to.toString());
  }
  const { data } = await auth.getSession();
  if (!data?.user) redirect(`/login?next=${encodeURIComponent("/oauth/authorize?" + q.toString())}`);
  const m = await me(data.user.id);
  if (!m || !m.premium || !m.may) redirect("/oauth/authorize?" + q.toString());
  redirect(await allow(a, m.tenantId, m.employeeId));
}

function Refused({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <AuthCard>
      <h1>{title}</h1>
      <p className="muted">{children}</p>
    </AuthCard>
  );
}

export default async function Authorize({ searchParams }: { searchParams: Promise<Sp> }) {
  const q = query(await searchParams);
  let a: Ask;
  try {
    a = await checkAsk(q);
  } catch (e) {
    if (e instanceof OAuthError) return <Refused title="Claude can't connect">{e.message}</Refused>;
    throw e;
  }
  const { data } = await auth.getSession();
  if (!data?.user) redirect(`/login?next=${encodeURIComponent("/oauth/authorize?" + q.toString())}`);
  const m = await me(data.user.id);
  if (!m) return <Refused title="Claude can't connect">This login belongs to no business. Sign in with your back office login.</Refused>;
  if (!m.premium) return <Refused title="Claude can't connect">EasyPay in Claude is part of EasyPay Premium.</Refused>;
  if (!m.may)
    return (
      <Refused title="Claude can't connect">
        Your role doesn&apos;t include <b>Use the assistant</b>. The owner can tick it for your role in the back office, under Staff, Roles.
      </Refused>
    );
  void a;
  return (
    <AuthCard>
      <h1>Connect Claude to {m.tenant}</h1>
      <p>
        Signed in as <b>{m.name}</b>.
      </p>
      <p className="muted">
        Claude will be able to read and change {m.tenant}&apos;s data as you, with what your role allows. Every change waits for you to confirm it. What Claude reads goes to
        Anthropic under your own Claude account.
      </p>
      <form action={decide} style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <input type="hidden" name="q" value={q.toString()} />
        <button type="submit">
          Allow
        </button>
        <button type="submit" name="no" value="1" className="auth-link" formNoValidate>
          Cancel
        </button>
      </form>
    </AuthCard>
  );
}
