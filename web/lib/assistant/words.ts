// How the assistant reads the owner's words against what a shop already has
// (spec Q5): "striped" is the stripe that 56 lines say, "3 - 6m" is 3-6m,
// "pale blue" is Pale Blue. Pure, with no imports, so its test runs it under
// node: `node web/lib/assistant/words.test.mjs`.

// A word as it is compared: no case, no accents, nothing but letters and
// digits, and its ending folded so stripe, stripes and striped are one, and
// design and designed. Two values are the same spelling of one thing when
// their keys are equal.
export function key(s: string): string {
  let k = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // a range of sizes stays a range: 1-2 is not 12, nor 3-4 34
    .replace(/(\d)\s*[-/]\s*(\d)/g, "$1to$2")
    .replace(/[^a-z0-9]/g, "");
  if (k.length > 4 && k.endsWith("ed")) k = k.slice(0, -2);
  else if (k.length > 4 && k.endsWith("es")) k = k.slice(0, -2);
  else if (k.length > 3 && k.endsWith("s") && !k.endsWith("ss")) k = k.slice(0, -1);
  if (k.length > 3 && k.endsWith("e")) k = k.slice(0, -1);
  return k;
}

export type Spelling = { value: string; lines: number };

// What a word is, among the spellings an option already has: the one most
// lines use, with the others that mean the same; or nothing, and the word is
// a new value.
export function read(word: string, have: Spelling[]): { value: string; lines: number; also: Spelling[] } | null {
  const k = key(word);
  if (!k) return null;
  const same = have.filter((h) => key(h.value) === k).sort((a, b) => b.lines - a.lines || a.value.localeCompare(b.value));
  if (same.length === 0) return null;
  return { value: same[0].value, lines: same[0].lines, also: same.slice(1) };
}

// A name as the shop's other names are written: each word with a capital, the
// rest as typed ("pale blue" is Pale Blue, "bois de roses" Bois De Roses).
// Digits and sizes (3-6m, 10) stay as they are.
export function titled(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    // a size as the shop writes its others: 3-6m, not 3 - 6m
    .replace(/\s*-\s*/g, "-")
    .replace(/(^|[\s/(-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

// The spellings of one option grouped by what they mean, each group with the
// spelling it would be tidied to (spec Q15): the title-cased form of the
// spelling most lines use.
export function groups(have: Spelling[]): { to: string; from: Spelling[]; lines: number }[] {
  const by = new Map<string, Spelling[]>();
  for (const h of have) {
    const k = key(h.value) || h.value;
    by.set(k, [...(by.get(k) ?? []), h]);
  }
  return [...by.values()]
    .map((from) => {
      const sorted = [...from].sort((a, b) => b.lines - a.lines || a.value.localeCompare(b.value));
      return { to: titled(sorted[0].value), from: sorted, lines: sorted.reduce((a, s) => a + s.lines, 0) };
    })
    .sort((a, b) => b.lines - a.lines || a.to.localeCompare(b.to));
}

// Pieces as the owner says them, in the thousandths the stock is kept in.
export const thousandths = (pieces: number) => Math.round(pieces * 1000);
// Rupees as said, in cents.
export const cents = (rupees: number) => Math.round(rupees * 100);
