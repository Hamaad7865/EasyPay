import { createMcpHandler } from "@modelcontextprotocol/server";
import { origin, who } from "@/lib/assistant/oauth";
import { serverFor } from "@/lib/assistant/server";

// EasyPay's connector, the address the owner gives their Claude
// (https://easypaypos.com/mcp). Each request stands alone: its token says who
// it is (lib/assistant/oauth.ts), and a server is made for that person alone.
// Without a valid token it answers 401 with where to sign in, which is how
// Claude knows to open EasyPay's sign-in.

// at most this many calls a minute for one connection (per Worker; enough to stop a runaway loop)
const PER_MINUTE = 120;
const calls = new Map<string, { n: number; since: number }>();
function tooMany(grant: string): boolean {
  const now = Date.now();
  const c = calls.get(grant);
  if (!c || now - c.since > 60_000) {
    calls.set(grant, { n: 1, since: now });
    return false;
  }
  c.n += 1;
  return c.n > PER_MINUTE;
}

// Claude's own pages, and EasyPay's: a browser page anywhere else can't call it with someone's token
const ORIGINS = ["https://claude.ai", "https://claude.com"];

async function serve(req: Request): Promise<Response> {
  const o = origin(req);
  const from = req.headers.get("origin");
  if (from && from !== o && !ORIGINS.includes(from)) return new Response("Not from Claude.", { status: 403 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || null;
  const w = await who(bearer);
  if (!w) {
    return Response.json(
      { error: "invalid_token", error_description: "Sign in to EasyPay to use it in Claude." },
      { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource/mcp"` } },
    );
  }
  if (tooMany(w.grantId ?? "")) return Response.json({ error: "slow_down", error_description: "Too many calls in a minute. Try again shortly." }, { status: 429 });
  const handler = createMcpHandler(() => serverFor(w, o), { responseMode: "json" });
  return handler.fetch(req, { authInfo: { token: bearer!, clientId: w.grantId ?? "", scopes: ["easypay"] } });
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
