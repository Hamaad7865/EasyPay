import { requirePlatformAdmin } from "@/lib/platform";
import { usageModel } from "@/lib/usage";
import { usageRows } from "./rows";
import { UsageView } from "./view";

// How much of Neon's allowance the database has used, what is left, and which
// client used it. Neon's own figures are the hourly job's last reading (the
// back office holds no key to Neon); what a client used is worked out from
// when it was active (web/lib/usage.ts).
export default async function UsagePage() {
  await requirePlatformAdmin();
  const m = usageModel({ ...(await usageRows()), now: Date.now() });
  return <UsageView m={m} />;
}
