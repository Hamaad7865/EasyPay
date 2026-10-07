"use client";

import { usePathname } from "next/navigation";

// What a page shows while its figures are on their way: its own frame (the
// heading, the cards, the lines of a table) with every piece of text a grey
// bar that a soft light passes over. The menu beside it stays in use. There
// are four frames, for the four kinds of page, and the address says which.
// The widths are written down, not drawn by lot: the server and the browser
// have to draw the same bars.

type Shape = "home" | "report" | "form" | "list";

const FORMS = ["settings", "company", "receipt-design", "data"];
const shapeOf = (path: string): Shape => {
  const page = path.split("/")[2] ?? "";
  if (!page) return "home";
  if (page === "reports" || page === "insights") return "report";
  return FORMS.includes(page) ? "form" : "list";
};

// A line of text that has not arrived: as tall as the line it stands for.
const Bar = ({ w }: { w: number | string }) => <span className="sk" style={{ width: w }} />;
// Something with a shape of its own: a field, a button, a round sign.
const Box = ({ w, h, round }: { w: number; h: number; round?: boolean }) => (
  <span className="sk-box" style={{ width: w, height: h, borderRadius: round ? 999 : undefined }} />
);

const Head = () => (
  <div className="page-head">
    <div>
      <h1>
        <Bar w={190} />
      </h1>
      <p className="lede">
        <Bar w={560} />
        <Bar w={380} />
      </p>
    </div>
  </div>
);

const WIDTHS = [62, 80, 48, 70, 56, 76, 44, 66, 58, 74];

// The lines of a table: the name at the start, the figures after it. The
// last lines fade, as a list that goes on does.
function Rows({ n, cols }: { n: number; cols: number }) {
  const line = { "--cols": cols } as React.CSSProperties;
  return (
    <div className="sk-rows">
      <div className="sk-tr sk-th" style={line}>
        {Array.from({ length: cols + 1 }, (_, c) => (
          <Bar key={c} w={c === 0 ? 70 : 52} />
        ))}
      </div>
      {Array.from({ length: n }, (_, r) => (
        <div className="sk-tr" key={r} style={line}>
          {Array.from({ length: cols + 1 }, (_, c) => (
            <Bar key={c} w={`${c === 0 ? WIDTHS[r % WIDTHS.length] : WIDTHS[(r * 3 + c * 7) % WIDTHS.length] - 10}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

function List() {
  return (
    <>
      <Head />
      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>
              <Bar w={130} />
            </h2>
            <p>
              <Bar w={250} />
            </p>
          </div>
          <Box w={280} h={36} round />
        </div>
        <Rows n={9} cols={4} />
      </section>
    </>
  );
}

function Report() {
  return (
    <>
      <Head />
      <div className="filters">
        {[150, 150, 170].map((w, i) => (
          <div className="sk-field" key={i}>
            <Bar w={46} />
            <Box w={w} h={36} />
          </div>
        ))}
        <Box w={74} h={36} round />
      </div>
      <div className="stats">
        {[112, 136, 84, 104].map((w, i) => (
          <div className="stat" key={i}>
            <div className="stat-label">
              <Bar w={w} />
            </div>
            <div className="stat-value">
              <Bar w={w + 14} />
            </div>
            <div className="stat-note">
              <Bar w={w + 30} />
            </div>
          </div>
        ))}
      </div>
      <section className="card flush">
        <div className="card-head">
          <h2>
            <Bar w={90} />
          </h2>
        </div>
        <Rows n={7} cols={3} />
      </section>
    </>
  );
}

function Form() {
  return (
    <>
      <Head />
      {[3, 2].map((n, card) => (
        <section className="card flush" key={card}>
          <div className="card-head">
            <h2>
              <Bar w={card ? 150 : 110} />
            </h2>
          </div>
          <div className="card-body">
            {Array.from({ length: n }, (_, i) => (
              <div className="setting" key={i}>
                <div className="sk-grow">
                  <strong>
                    <Bar w={WIDTHS[i + card] * 3} />
                  </strong>
                  <small>
                    <Bar w="92%" />
                    <Bar w={`${WIDTHS[i + card + 3]}%`} />
                  </small>
                </div>
                <Box w={150} h={34} round />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

// The dashboard's first screen: the greeting with the day's figures beside
// it, then the two panes.
function Home() {
  const pane = (title: number, lines: number[]) => (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h2>
            <Bar w={title} />
          </h2>
          <p>
            <Bar w={title + 90} />
          </p>
        </div>
      </div>
      <div className="pane-in">
        {lines.map((w, i) => (
          <div className="need" key={i}>
            <Box w={36} h={36} round />
            <div className="need-text">
              <b>
                <Bar w={`${w}%`} />
              </b>
              <span>
                <Bar w={`${w + 18}%`} />
              </span>
            </div>
            <Box w={72} h={34} round />
          </div>
        ))}
      </div>
    </section>
  );
  return (
    <div className="home">
      <header className="home-head">
        <div>
          <p className="home-where">
            <Bar w={210} />
          </p>
          <h1>
            <Bar w={330} />
          </h1>
          <p className="home-status">
            <Bar w={400} />
          </p>
        </div>
        <div className="home-side">
          {[104, 72, 88].map((w, i) => (
            <div className="home-fig" key={i}>
              <small>
                <Bar w={w - 24} />
              </small>
              <strong>
                <Bar w={w} />
              </strong>
              <span>
                <Bar w={w + 16} />
              </span>
            </div>
          ))}
        </div>
      </header>
      <div className="home-top">
        {pane(150, [52, 64, 44])}
        {pane(96, [58, 46, 62])}
      </div>
    </div>
  );
}

const SHAPES = { home: Home, report: Report, form: Form, list: List };

export function PageSkeleton({ shape }: { shape?: Shape }) {
  const path = usePathname();
  const Frame = SHAPES[shape ?? shapeOf(path)];
  return (
    <div className="sk-page" role="status" aria-busy="true" aria-label="Loading">
      <Frame />
    </div>
  );
}
