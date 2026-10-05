import type { Metadata } from "next";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Choose a new password · EasyPay" };

// Where the link in the "forgot password" email lands: with ?token=... when
// the link is good, with ?error=INVALID_TOKEN when it is too old or was
// already used.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const q = await searchParams;
  const token = typeof q.token === "string" && !q.error ? q.token : "";
  return <ResetForm token={token} />;
}
