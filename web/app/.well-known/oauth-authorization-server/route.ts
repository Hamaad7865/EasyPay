import { origin, serverMetadata } from "@/lib/assistant/oauth";

// How Claude signs in to EasyPay (RFC 8414): where to register, ask and get its tokens.
const OPEN = { "access-control-allow-origin": "*" };
export function GET(req: Request) {
  return Response.json(serverMetadata(origin(req)), { headers: OPEN });
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...OPEN, "access-control-allow-headers": "*" } });
}
