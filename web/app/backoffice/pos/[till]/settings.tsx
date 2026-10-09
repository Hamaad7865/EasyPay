import { clock } from "@/lib/report";
import { ConfirmSubmit } from "../../../admin/confirm";
import { Submit } from "../../busy";
import { Card } from "../../ui";
import type { Base } from "./types";

type Change = (f: FormData) => Promise<void>;

// Settings: the till's name, and whether it is a till at all. For a login
// that may change how a till is set up; anyone else reads it. The code is
// not a setting: it is in every receipt number the till has issued.
export function Settings({ d, rename, setActive }: { d: Base & { can: boolean }; rename: Change; setActive: Change }) {
  const { t } = d;
  const at = clock(d.tz);
  return (
    <div>
      {!d.can && <div className="note">Your role does not include changing how a till is set up. Ask the owner to do it, or to tick it on your role.</div>}
      <Card title="Name" lede="What this till is called here, on its own screen and on a kitchen screen. The tablet shows a new name after its next sync.">
        <form action={rename}>
          <input type="hidden" name="till" value={t.id} />
          <label className="field">
            Name
            <input name="name" defaultValue={t.name} maxLength={40} required disabled={!d.can} />
          </label>
          {d.can && <Submit>Save</Submit>}
        </form>
      </Card>

      {t.off ? (
        <Card title="Reactivate this till" lede="It was deactivated: its tablet cannot sync as this till. Reactivated, someone signs in on the tablet again and it carries on with its receipt numbers.">
          <form action={setActive}>
            <input type="hidden" name="till" value={t.id} />
            <input type="hidden" name="active" value="yes" />
            {d.can && <Submit>Reactivate</Submit>}
          </form>
        </Card>
      ) : (
        <Card
          title="Deactivate this till"
          lede="For a tablet that was lost, sold or put away. It goes back to its sign-in at its next sync and can no longer be used as this till. Sales it has not sent yet are still taken once someone signs in on it, and it can be reactivated here."
        >
          <form action={setActive}>
            <input type="hidden" name="till" value={t.id} />
            <input type="hidden" name="active" value="no" />
            {d.can && (
              <ConfirmSubmit
                className="btn-danger"
                title={`Deactivate ${t.name}?`}
                text={
                  (t.shift_id ? "It has its day open: close the day on the tablet first if you can. " : "") +
                  "The tablet goes back to its sign-in at its next sync. Sales it has not sent yet are still taken once someone signs in on it. You can reactivate it here."
                }
                yes="Deactivate"
              >
                Deactivate
              </ConfirmSubmit>
            )}
          </form>
        </Card>
      )}

      <Card title="About this till">
        <dl className="kv" style={{ maxWidth: 420 }}>
          <dt>Store</dt>
          <dd>{t.store}</dd>
          <dt>Code</dt>
          <dd>{t.code}</dd>
          <dt>Set up</dt>
          <dd>{at(t.created_at)}</dd>
          <dt>App build</dt>
          <dd>{t.till_version === null ? (t.app_version ?? "Not said yet") : `Build ${t.till_version}`}</dd>
        </dl>
        <p className="help">The code is in every receipt number this till has issued, so it is not changed.</p>
      </Card>
    </div>
  );
}
