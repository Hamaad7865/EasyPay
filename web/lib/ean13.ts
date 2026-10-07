// EAN-13 as bars: the check digit and the module encoding, for the label
// sheet. Pure functions with no imports, so the same code runs on the server
// and in the browser. Carried over from Kids Corner's lib/barcodes/ean13.ts,
// where it has labelled a shop's stock since 2026; the numbering itself
// (prefix, serial) is the database's here (ean13() in migration 0070).
//
// Hand-rolled rather than a dependency: EAN-13 is a fixed 95-module symbol
// that has not changed since 1977. The whole specification is the three
// tables below.

// Left-hand digit encodings. Odd parity (L) and even parity (G): which of the
// two is used for each of the six left digits is what encodes the FIRST
// digit, since a 13-digit code only has room to draw 12.
const L_CODES = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"] as const;
const G_CODES = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"] as const;
// Right-hand digits are always even parity, and are the L codes inverted.
const R_CODES = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"] as const;
// Parity of the six left digits, selected by the first digit of the code.
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"] as const;

const GUARD_START = "101";
const GUARD_CENTRE = "01010";
const GUARD_END = "101";

// Modules in a complete symbol: 3 + 42 + 5 + 42 + 3.
export const EAN13_MODULES = 95;

const isDigits = (value: string) => /^\d+$/.test(value);

// The check digit for a 12-digit payload: weights alternate 1,3,1,3... from
// the left; the check digit takes the weighted sum up to the next ten.
export function ean13CheckDigit(payload: string): number {
  if (payload.length !== 12 || !isDigits(payload)) throw new Error("An EAN-13 payload is 12 digits");
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(payload[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

// True when `code` is 13 digits and its final digit is the correct check.
export function isValidEan13(code: string): boolean {
  if (code.length !== 13 || !isDigits(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

// What can be drawn as EAN-13 bars: a valid 13-digit code as it is, and a
// valid 12-digit UPC-A, which is the same symbol with a zero in front. A
// maker's code of any other kind (EAN-8, letters) comes back as null: the
// label then prints it as text, and a scanner reads the maker's own print.
export function asEan13(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (isValidEan13(c)) return c;
  if (c.length === 12 && isValidEan13("0" + c)) return "0" + c;
  return null;
}

// Encodes a code to its 95 modules, as a string of "0" (space) and "1" (bar).
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) throw new Error(`Not a valid EAN-13: ${code}`);
  const digits = code.split("").map(Number);
  const parity = PARITY[digits[0]];
  let left = "";
  for (let i = 0; i < 6; i += 1) {
    const digit = digits[i + 1];
    left += parity[i] === "L" ? L_CODES[digit] : G_CODES[digit];
  }
  let right = "";
  for (let i = 0; i < 6; i += 1) right += R_CODES[digits[i + 7]];
  return GUARD_START + left + GUARD_CENTRE + right + GUARD_END;
}

// Collapses the module string into runs of bars, ready to draw as rects. One
// rect per run rather than per module: a scanner reads the same symbol either
// way, but this turns 95 elements into about 30, which matters when a sheet
// holds 24 labels.
export function ean13Bars(code: string): { x: number; width: number }[] {
  const modules = ean13Modules(code);
  const bars: { x: number; width: number }[] = [];
  let run = 0;
  for (let i = 0; i < modules.length; i += 1) {
    if (modules[i] === "1") {
      run += 1;
      continue;
    }
    if (run > 0) {
      bars.push({ x: i - run, width: run });
      run = 0;
    }
  }
  if (run > 0) bars.push({ x: modules.length - run, width: run });
  return bars;
}

// A code the way it is printed under the symbol: the first digit sits outside
// the bars, then two groups of six.
export function ean13HumanGroups(code: string): [string, string, string] {
  return [code.slice(0, 1), code.slice(1, 7), code.slice(7)];
}
