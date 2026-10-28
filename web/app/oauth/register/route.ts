import { OAuthError, register } from "@/lib/assistant/oauth";

// A Claude registering itself before it signs in (RFC 7591). Only Claude's
// own callback addresses are taken.
const OPEN = { "access-control-allow-origin": "*" };
export async function POST(req: Request) {
  try {
    const made = await register(await req.json().catch(() => null));
    return Response.json({ ...made, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { status: 201, headers: OPEN });
  } catch (e) {
    if (e instanceof OAuthError) return Response.json({ error: e.code, error_description: e.message }, { status: 400, headers: OPEN });
    throw e;
  }
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...OPEN, "access-control-allow-headers": "*" } });
}
