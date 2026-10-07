// MUR integer cents. No floats near money (spec 15).
export function fmtRs(cents: number): string {
  return "Rs " + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// A price as typed: digits, commas between thousands allowed, at most two
// decimals. Anything else is not a price ("12abc" used to be read as Rs 12),
// and a third decimal is refused rather than rounded.
export function parseRs(input: string): number | null {
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(input.replace(/,/g, "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] || "0") * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
