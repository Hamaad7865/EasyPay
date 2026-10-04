import type { LucideIcon } from "lucide-react";

// The few pieces every back office page is put together from.

export type Search = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function PageHead({ title, lede, children }: { title: string; lede?: string; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

// The line an action leaves behind: what was saved, or why it was not.
export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const ok = one(sp.ok);
  const err = one(sp.err);
  if (err) return <div className="note danger" role="alert">{err}</div>;
  if (ok) return <div className="note ok" role="status">{ok}</div>;
  return null;
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <Icon aria-hidden="true" strokeWidth={1.6} />
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Card({ title, lede, action, children, flush }: { title?: string; lede?: string; action?: React.ReactNode; children: React.ReactNode; flush?: boolean }) {
  return (
    <section className="card flush">
      {title && (
        <div className="card-head">
          <div>
            <h2>{title}</h2>
            {lede && <p>{lede}</p>}
          </div>
          {action}
        </div>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}
