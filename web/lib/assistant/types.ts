// What the assistant's cards are drawn from (spec, The card). A card is data
// the server worked out from the business's own rows; lib/assistant/card.ts
// turns it into the HTML Claude shows, and the back office's confirm page
// shows the same. Nothing here is the AI's: it never writes a card.

// A line's stock as the tablet says it: plenty, a few, none.
export type Tone = "plenty" | "few" | "none" | "below";

// The product's tile, as on the Sell screen.
export type Tile = { name: string; price: string; category: string | null; picture: string | null; lines: number; pieces: string | null };

// The tablet's sheet that asks which variant: per option its values, the lit
// one, and on the last option's keys what is left of each.
export type SheetKey = { value: string; on: boolean; left: string | null; tone: Tone | null; isNew?: boolean };
export type Sheet = { options: { name: string; keys: SheetKey[]; more: number }[]; add: string };

// "I read this as": what the owner said, what it is in the shop, and where
// that came from ("56 lines", "the product's price", "suggested").
export type Reading = { said: string; is: string; note: string | null; isNew: boolean };

export type StockMove = { branch: string; line: string; before: string; after: string };

export type Warning = { tone: "amber" | "red"; text: string };

// A product with its stock as grids (spec Q28): per value of its last option
// when it has three, else one grid; the first option down, the second across.
export type Grid = { title: string | null; rows: string[]; cols: string[]; cells: ({ qty: string; tone: Tone; line: string } | null)[][] };

export type ProductCard = {
  kind: "product";
  tile: Tile;
  path: string | null;
  options: { name: string; values: { value: string; lines: number }[] }[];
  grids: Grid[];
  branch: string;
  plain: { line: string; qty: string; tone: Tone }[];
};

export type LinesCard = { kind: "lines"; title: string; rows: { product: string; line: string; branch: string; qty: string; tone: Tone }[]; more: number };

export type HistoryCard = {
  kind: "history";
  product: string;
  line: string;
  now: string;
  rows: { when: string; what: string; qty: string; branch: string; who: string | null; ref: string | null }[];
  more: boolean;
};

// A change worked out and waiting (spec Q3, Q10, Q14): built from the rows
// the change made, then undone.
export type PreviewCard = {
  kind: "preview";
  title: string;
  business: string;
  readings: Reading[];
  tile: Tile | null;
  sheet: Sheet | null;
  stock: StockMove[];
  // the changes in words, the first few shown, the rest folded
  lines: string[];
  warnings: Warning[];
  danger: boolean;
  confirm: string;
  // typed before Confirm works (spec Q14): the business's name
  typeName: string | null;
  proposal: string;
  expires: string;
  // where the same can be confirmed in the back office
  link: string;
};

export type DoneCard = { kind: "done"; title: string; lines: string[]; tile: Tile | null; sheet: Sheet | null };

export type Card = ProductCard | LinesCard | HistoryCard | PreviewCard | DoneCard;
