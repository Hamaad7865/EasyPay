import qrcode from "qrcode-generator";

// Ordering from the table (docs/superpowers/specs/2026-10-10-table-ordering-design.md):
// what the back office has of it. A guest scans the code on their table's
// card, the page at ORDER_SITE shows the menu the restaurant's till published,
// and the order goes to the till. The back office switches it on (POS
// settings) and prints the cards.

// Where a table's card sends a phone (cloudflare/relay).
export const ORDER_SITE = "https://order.easypaypos.com";

const STORE = /^[a-z2-7]{16}$/;
const TABLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The address on a table's card: the store's public id (stores.guest_id,
// migration 0093) and the table's id. Both are for good, so a card printed
// once goes on working; neither is a secret, a card on a table shows them.
export function cardAddress(storeGuestId: string, tableId: string): string {
  if (!STORE.test(storeGuestId)) throw new Error("not a store's public id");
  if (!TABLE.test(tableId)) throw new Error("not a table's id");
  return `${ORDER_SITE}/${storeGuestId}/${tableId}`;
}

// The QR code of a piece of text, as squares to draw: how many to a side,
// and one SVG path that fills the dark ones, in a box of that many units. A
// run of dark squares in a row is one stroke, so a card's code is a short
// path and not a thousand rectangles. Level M: a card that is a little worn
// or creased still reads.
export function qrSquares(text: string): { side: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const side = qr.getModuleCount();
  let path = "";
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      if (!qr.isDark(r, c)) continue;
      let end = c;
      while (end + 1 < side && qr.isDark(r, end + 1)) end++;
      const run = end - c + 1;
      path += `M${c} ${r}h${run}v1h-${run}z`;
      c = end;
    }
  }
  return { side, path };
}
