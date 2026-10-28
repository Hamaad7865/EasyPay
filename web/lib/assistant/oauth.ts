import { db } from "@/lib/db";
import { hasPremium } from "@/lib/plan";
import { asMode, type Mode } from "@/lib/mode";

// The owner's Claude signs in to a business as one of its back office logins
// (spec, How the owner connects): OAuth 2.1 with dynamic client
// registration, PKCE (S256) only, and Claude's own callback the only one
// accepted. Tokens are random and kept only as SHA-256 hashes
// (assistant_grants, 0146). Everything here asks as the owner role: a token
// says which business it is for before anything is asked as that business.

export const CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
const ACCESS_SECONDS = 3600;
const CODE_SECONDS = 300;

// The address Claude was given (https://easypaypos.com), as this request
// reached it: through the public site in production, through the test copy's
// own address when testing.
export function origin(req: Request): string {
  const fixed = process.env.ASSISTANT_ORIGIN;
  if (fixed) return fixed.replace(/\/$/, "");
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export const resourceMetadata = (o: string) => ({
  resource: `${o}/mcp`,
  authorization_servers: [o],
  bearer_methods_supported: ["header"],
  resource_name: "EasyPay",
});
export const serverMetadata = (o: string) => ({
  issuer: o,
  authorization_endpoint: `${o}/oauth/authorize`,
  token_endpoint: `${o}/oauth/token`,
  registration_endpoint: `${o}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["easypay"],
});

// A Claude registering itself. Only Claude's callbacks are taken.
export async function register(body: unknown): Promise<{ client_id: string; redirect_uris: string[]; client_name: string | null }> {
  const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (uris.length === 0 || !uris.every((u) => CALLBACKS.includes(u))) throw new OAuthError("invalid_redirect_uri", "Only Claude can connect to EasyPay.");
  const id = "claude_" + random(18);
  const name = typeof b.client_name === "string" ? b.client_name.slice(0, 80) : null;
  await db().query(`insert into assistant_clients (client_id, name, redirect_uris) values ($1, $2, $3)`, [id, name, uris]);
  return { client_id: id, redirect_uris: uris, client_name: name };
}

export class OAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// What /oauth/authorize was asked, checked before anything is shown.
export type Ask = { client_id: string; redirect_uri: string; state: string; challenge: string; resource: string | null };
export async function checkAsk(q: URLSearchParams): Promise<Ask> {
  const ask = {
    client_id: q.get("client_id") ?? "",
    redirect_uri: q.get("redirect_uri") ?? "",
    state: q.get("state") ?? "",
    challenge: q.get("code_challenge") ?? "",
    resource: q.get("resource"),
  };
  if (q.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "EasyPay only signs in with a code.");
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(ask.challenge)) throw new OAuthError("invalid_request", "The sign-in is missing its PKCE challenge.");
  const c = await db().query(`select redirect_uris from assistant_clients where client_id = $1`, [ask.client_id]);
  if (!c.rowCount) throw new OAuthError("invalid_client", "This Claude is not registered with EasyPay. Remove the connector in Claude and add it again.");
  if (!(c.rows[0].redirect_uris as string[]).includes(ask.redirect_uri)) throw new OAuthError("invalid_request", "That is not this Claude's address.");
  return ask;
}

// Allow pressed: a one-time code for the login's business, back to Claude.
export async function allow(ask: Ask, tenantId: string, employeeId: string): Promise<string> {
  const code = random(32);
  await db().query(
    `insert into assistant_codes (code_hash, client_id, tenant_id, employee_id, redirect_uri, challenge, resource, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [await sha256(code), ask.client_id, tenantId, employeeId, ask.redirect_uri, ask.challenge, ask.resource, CODE_SECONDS],
  );
  const to = new URL(ask.redirect_uri);
  to.searchParams.set("code", code);
  if (ask.state) to.searchParams.set("state", ask.state);
  return to.toString();
}

export type Tokens = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };

async function issue(grantId: string): Promise<Tokens> {
  const access = "ep_at_" + random(32);
  const refresh = "ep_rt_" + random(32);
  // the old refresh token stops working as the new one is made (rotation)
  await db().query(
    `update assistant_grants set access_hash = $2, access_expires = now() + make_interval(secs => $3), refresh_hash = $4 where id = $1`,
    [grantId, await sha256(access), ACCESS_SECONDS, await sha256(refresh)],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: "easypay" };
}

// The token endpoint: a code for tokens, or a refresh token for new ones.
export async function token(form: URLSearchParams): Promise<Tokens> {
  const grant = form.get("grant_type");
  const client = form.get("client_id") ?? "";
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const found = await db().query(
      `update assistant_codes set used_at = now()
        where code_hash = $1 and used_at is null and expires_at > now()
        returning client_id, tenant_id, employee_id, redirect_uri, challenge`,
      [await sha256(code)],
    );
    const c = found.rows[0];
    if (!c || c.client_id !== client || c.redirect_uri !== form.get("redirect_uri")) throw new OAuthError("invalid_grant", "That sign-in has run out. Connect again.");
    if ((await s256(form.get("code_verifier") ?? "")) !== c.challenge) throw new OAuthError("invalid_grant", "That sign-in could not be checked. Connect again.");
    const made = await db().query(`insert into assistant_grants (tenant_id, employee_id, client_id) values ($1, $2, $3) returning id`, [c.tenant_id, c.employee_id, c.client_id]);
    return issue(made.rows[0].id);
  }
  if (grant === "refresh_token") {
    const found = await db().query(
      `select id, client_id from assistant_grants where refresh_hash = $1 and ended_at is null`,
      [await sha256(form.get("refresh_token") ?? "")],
    );
    const g = found.rows[0];
    if (!g || g.client_id !== client) throw new OAuthError("invalid_grant", "This connection was ended. Connect again.");
    return issue(g.id);
  }
  throw new OAuthError("unsupported_grant_type", "EasyPay does not sign in that way.");
}

// Who a request is: the connection its token is, and whether that still
// holds. A login that lost Use the assistant, left, or whose business left
// Premium ends its connection here (spec Q27); a suspended business keeps it,
// for questions only.
export type Who = {
  // null on the back office's own confirm page, which is no connection
  grantId: string | null;
  tenantId: string;
  employeeId: string;
  employeeName: string;
  tenantName: string;
  mode: Mode;
  suspended: boolean;
};
export async function who(bearer: string | null): Promise<Who | null> {
  if (!bearer) return null;
  const r = await db().query(
    `select g.id, g.tenant_id, g.employee_id, e.name as employee_name, t.name as tenant_name, t.business_type, t.plan, t.status,
            e.deleted_at is null and e.is_active as here, has_perm(e.id, 'assistant.use') as may
       from assistant_grants g
       join employees e on e.id = g.employee_id and e.tenant_id = g.tenant_id
       join tenants t on t.id = g.tenant_id
      where g.access_hash = $1 and g.ended_at is null and g.access_expires > now()`,
    [await sha256(bearer)],
  );
  const g = r.rows[0];
  if (!g) return null;
  const why = !g.here ? "left" : !g.may ? "no-permission" : !hasPremium(g.plan) ? "plan" : null;
  if (why) {
    await db().query(`update assistant_grants set ended_at = now(), ended_why = $2 where id = $1`, [g.id, why]);
    return null;
  }
  await db().query(`update assistant_grants set last_used_at = now() where id = $1`, [g.id]);
  return {
    grantId: g.id,
    tenantId: g.tenant_id,
    employeeId: g.employee_id,
    employeeName: g.employee_name ?? "",
    tenantName: g.tenant_name ?? "",
    mode: asMode(g.business_type),
    suspended: g.status !== "active",
  };
}
