import Link from "next/link";
import { cardAddress, ORDER_SITE, qrSquares } from "@/lib/guest";
import { PageHead } from "../../ui";
import { Wait } from "../../busy";
import { PrintButton } from "../../reports/print-button";

export type CardStore = { id: string; name: string; guest_id: string };
export type CardTable = { id: string; name: string; area: string };

// The cards of one store's tables, as they are printed. What the page asks the
// database for is handed in, so the cards can be drawn from sample rows too.
export function CardsView({ name, stores, store, tables, on }: { name: string; stores: CardStore[]; store: CardStore | null; tables: CardTable[]; on: boolean }) {
  const site = ORDER_SITE.replace(/^https:\/\//, "");
  return (
    <div>
      <PageHead title="Table cards" lede="A card for each table, with the code a guest scans to see the menu and order. Print them, cut them out and put one on each table. A card goes on working for as long as its table exists.">
        {tables.length > 0 && <PrintButton />}
      </PageHead>
      {stores.length > 1 && (
        <p className="bo-chips no-print">
          {stores.map((s) => (
            <Link key={s.id} href={`/backoffice/tables/cards?store=${s.id}`} className={s.id === store?.id ? "on" : undefined}>
              {s.name}
              <Wait />
            </Link>
          ))}
        </p>
      )}
      {!on && (
        <p className="note warn no-print">
          Ordering from the table is switched off, so a guest who scans a card is told to ask a member of staff. Switch it on under{" "}
          <Link href="/backoffice/settings">POS settings</Link>.
        </p>
      )}
      {store && tables.length === 0 && (
        <p className="muted">
          This store has no tables yet. Draw them under <Link href={`/backoffice/tables?store=${store.id}`}>Tables</Link>, then come back for their cards.
        </p>
      )}
      {!store && <p className="muted">This restaurant has no store yet.</p>}
      {store && (
        <div className="tcards">
          {tables.map((t) => {
            const code = qrSquares(cardAddress(store.guest_id, t.id));
            return (
              <article className="tcard" key={t.id}>
                {name && <p className="tcard-place">{name}</p>}
                {/* four light squares all round: a phone needs the band to find the code */}
                <svg viewBox={`-4 -4 ${code.side + 8} ${code.side + 8}`} shapeRendering="crispEdges" role="img" aria-label={`The code for ${t.name}`}>
                  <path d={code.path} />
                </svg>
                <h2>{t.name}</h2>
                {t.area && <p className="tcard-area">{t.area}</p>}
                <p className="tcard-how">Scan with your phone&apos;s camera to see the menu and order from your seat.</p>
                <p className="tcard-site">{site}</p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
