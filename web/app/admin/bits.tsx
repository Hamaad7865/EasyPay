// The few pieces the admin pages share.

// The line an action leaves behind: what was done, or why it was not.
export function Notes({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <div className="note danger" role="alert">{error}</div>;
  if (notice) return <div className="note ok" role="status">{notice}</div>;
  return null;
}

// "restaurant" as a word that starts a line
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The start of a restaurant's id: what its back office shows its owner to
// quote to EasyPay support.
export const supportId = (tenantId: string) => tenantId.slice(0, 8).toUpperCase();

// Dates as they read in Mauritius, whatever clock the server keeps.
const TZ = "Indian/Mauritius";
type When = string | number | Date;

export const day = (v: When) => new Date(v).toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
export const dayTime = (v: When) =>
  new Date(v).toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

// How long ago, by the calendar: today, yesterday, so many days, then the date.
export function ago(v: When, now: number = Date.now()): string {
  const midnight = (t: When) => Date.parse(new Date(t).toLocaleDateString("en-CA", { timeZone: TZ }) + "T00:00:00Z");
  const days = Math.round((midnight(now) - midnight(v)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return days <= 30 ? `${days} days ago` : day(v);
}
