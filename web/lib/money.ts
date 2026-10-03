// MUR integer cents. No floats near money (spec 15).
export function fmtRs(cents: number): string {
  return "Rs " + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function parseRs(input: string): number | null {
  const v = Number.parseFloat(input.replace(/,/g, "").trim());
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 100);
}
