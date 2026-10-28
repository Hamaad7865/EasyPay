import { origin, resourceMetadata } from "@/lib/assistant/oauth";

// Where Claude learns who signs it in to EasyPay's connector (RFC 9728), at
// /.well-known/oauth-protected-resource and at the same with /mcp after it.
const OPEN = { "access-control-allow-origin": "*" };
export function GET(req: Request) {
  return Response.json(resourceMetadata(origin(req)), { headers: OPEN });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...OPEN, "access-control-allow-headers": "*" } });
}
