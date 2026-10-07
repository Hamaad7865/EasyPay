// MUR integer cents. No floats near money (spec 15).
export function fmtRs(cents: number): string {
  return "Rs " + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// A price as typed: digits, at most two decimals after a point, and commas
// only between thousands. Anything else is not a price: "12abc" used to be
// read as Rs 12, and "12,50" (twelve fifty, written the French way) as
// Rs 1,250. A third decimal is refused rather than rounded.
export function parseRs(input: string): number | null {
  const m = /^(\d*|\d{1,3}(?:,\d{3})+)(?:\.(\d{0,2}))?$/.exec(input.trim());
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1].replace(/,/g, "") || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
