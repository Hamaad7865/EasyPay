import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { onlyFor } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { act, int, Refused, text, UUID, uuid } from "@/lib/action";
import { parseRs } from "@/lib/money";
import * as saves from "@/lib/saves";
import { loadSettings, money } from "@/lib/settings";
import { Card, Empty, Flash, one, PageHead, type Search } from "../ui";
import { AddonsTable, type Choice, type Group } from "./table";
import { Submit } from "../busy";

const PATH = "/backoffice/addons";
// After a save the page comes back with the group that was being worked on
// still open: nobody wants to find it again after every choice they add.
const back = (group: FormDataEntryValue | null | string) => (typeof group === "string" && UUID.test(group) ? `${PATH}?open=${group}` : PATH);

async function addGroup(f: FormData) {
  "use server";
  // its id is made here so the page can come back with the new group open
  const id = crypto.randomUUID();
  await act("items.edit", back(id), async (c, ctx) => {
    const name = text(f, "name", 40);
    if (!name) throw new Refused("Give the group a name, for example Extras or Cooking.");
    await c.query(`insert into modifier_groups (id, tenant_id, name, min_select, max_select) values ($1, $2, $3, 0, 0)`, [id, ctx.tenantId, name]);
    return `${name} added. Now add its choices.`;
  });
}

// min 0 = optional, min 1 = the waiter must pick; max 0 = as many as they like.
async function saveGroup(f: FormData) {
  "use server";
  await act("items.edit", f.get("remove") === "1" ? PATH : back(f.get("id")), async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      await c.query(`update item_modifier_groups set deleted_at = now() where tenant_id = $1 and group_id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      await c.query(`update modifiers set deleted_at = now() where tenant_id = $1 and group_id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      // a removed group's name is free again
      await c.query(`update modifier_groups set deleted_at = now(), name = name || ' (removed ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')' where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      return "Group removed.";
    }
    const name = text(f, "name", 40);
    if (!name) throw new Refused("A group needs a name.");
    const min = int(f, "min", 0, 20, 0);
    const max = int(f, "max", 0, 20, 0);
    if (max !== 0 && max < min) throw new Refused("The most that can be picked cannot be less than the fewest.");
    if (!(await saves.saveGroup(c, ctx.tenantId, id, name, min, max))) throw new Refused("That group is no longer there. Reload the page.");
    return `${name} saved.`;
  });
}

async function addChoice(f: FormData) {
  "use server";
  await act("items.edit", back(f.get("group")), async (c, ctx) => {
    const group = uuid(f, "group");
    const name = text(f, "name", 40);
    const price = parseRs(String(f.get("price") || "0"));
    if (!name) throw new Refused("Give the choice a name.");
    if (price === null) throw new Refused("The price is not a number.");
    if (!(await saves.addChoice(c, ctx.tenantId, group, name, price))) throw new Refused("That group is no longer there, so the choice was not added. Reload the page.");
    return `${name} added.`;
  });
}

async function saveChoice(f: FormData) {
  "use server";
  await act("items.edit", back(f.get("group")), async (c, ctx) => {
    const id = uuid(f, "id");
    if (f.get("remove") === "1") {
      await c.query(`update modifiers set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
      return "Choice removed.";
    }
    const name = text(f, "name", 40);
    const price = parseRs(String(f.get("price") || "0"));
    if (!name || price === null) throw new Refused("A choice needs a name and a price (0 for free).");
    if (!(await saves.saveChoice(c, ctx.tenantId, id, name, price))) throw new Refused("That choice is no longer there. Reload the page.");
    return `${name} saved.`;
  });
}

export default async function AddonsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await onlyFor("restaurant");
  const d = await readTenant(ctx.tenantId, async (c) => ({
    settings: await loadSettings(c, ctx.tenantId),
    groups: (
      await c.query(
        `select g.id, g.name, g.min_select, g.max_select,
                (select count(*)::int from item_modifier_groups x join items i on i.tenant_id = x.tenant_id and i.id = x.item_id and i.deleted_at is null
                  where x.tenant_id = g.tenant_id and x.group_id = g.id and x.deleted_at is null) as items
           from modifier_groups g where g.tenant_id = $1 and g.deleted_at is null order by g.name`,
        [ctx.tenantId],
      )
    ).rows as Group[],
    choices: (
      await c.query(`select id, group_id, name, price from modifiers where tenant_id = $1 and deleted_at is null order by created_at, name`, [ctx.tenantId])
    ).rows as Omit<Choice, "shown">[],
  }));
  const choices: Choice[] = d.choices.map((m) => ({ ...m, price: String(m.price), shown: Number(m.price) === 0 ? "" : "+ " + money(Number(m.price), d.settings.decimals) }));
  const open = one(sp.open);
  return (
    <div>
      <PageHead
        title="Add-ons"
        lede="Extras and choices the till offers when an item is tapped: extra cheese, no chili, how it is cooked. A group is attached to the items it applies to, on each item's page."
      />
      <Flash sp={sp} />
      <Card title="Add a group">
        <form action={addGroup} className="bo-toolbar" style={{ margin: 0 }}>
          <input name="name" placeholder="Name, for example Extras" required maxLength={40} style={{ minWidth: 260 }} />
          <Submit>Add group</Submit>
        </form>
      </Card>
      {d.groups.length === 0 ? (
        <Empty icon={SlidersHorizontal} title="No add-on groups yet">Create one above, then add its choices and tick it on the items it belongs to.</Empty>
      ) : (
        // keyed by what is open, so coming back from a save opens that group even when the page was already showing
        <AddonsTable key={open} groups={d.groups} choices={choices} open={UUID.test(open) ? open : null} saveGroup={saveGroup} addChoice={addChoice} saveChoice={saveChoice} />
      )}
      <p className="muted">Attach a group to an item on the item&apos;s page, under <Link href="/backoffice/items">Items</Link>.</p>
    </div>
  );
}
