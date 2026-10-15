import type { Align, Styled } from "@/lib/papers";

// The paper as the till prints it: each line in a fixed-width face, as many
// characters across as the printer has (32 on 58 mm, 48 on 80 mm). Big is
// twice as wide and as tall, Tall twice as tall; bars stand for the barcode.
// The logo is drawn where its block is.
export function PaperPreview({ lines, columns, logo, logoAt, logoAlign }: { lines: Styled[]; columns: number; logo: string | null; logoAt: number | null; logoAlign: Align }) {
  const picture = (key: string) =>
    // eslint-disable-next-line @next/next/no-img-element
    logo ? <img key={key} src={logo} alt="" className={"pp-logo " + logoAlign} /> : null;
  const out: React.ReactNode[] = [];
  lines.forEach((l, i) => {
    if (logoAt === i) out.push(picture("logo"));
    out.push(
      l.bars !== undefined ? (
        <div key={i} className="pp-bars" title={"Barcode: " + l.bars} />
      ) : (
        <div key={i} className={"pp-line " + l.size + (l.bold ? " b" : "")} style={{ textAlign: l.align }}>
          {l.t || " "}
        </div>
      ),
    );
  });
  if (logoAt !== null && logoAt >= lines.length) out.push(picture("logo"));
  return (
    <div className="pp" style={{ "--cols": columns } as React.CSSProperties}>
      {out}
    </div>
  );
}
