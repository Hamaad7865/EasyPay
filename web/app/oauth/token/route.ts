import { OAuthError, token } from "@/lib/assistant/oauth";

// Claude's code, or its refresh token, for tokens. Each refresh token works once.
const OPEN = { "access-control-allow-origin": "*", "cache-control": "no-store" };
export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  const form = type.includes("application/json")
    ? new URLSearchParams(Object.entries((await req.json().catch(() => ({}))) as Record<string, string>))
    : new URLSearchParams(await req.text());
  try {
    return Response.json(await token(form), { headers: OPEN });
  } catch (e) {
    if (e instanceof OAuthError) return Response.json({ error: e.code, error_description: e.message }, { status: 400, headers: OPEN });
    throw e;
  }
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...OPEN, "access-control-allow-headers": "*" } });
}
