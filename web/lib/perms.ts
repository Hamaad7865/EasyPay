import type { Mode } from "@/lib/mode";

// Every permission the tills and the back office check, in the words of what
// it lets someone do, as the Roles page offers them. Pure, so
// `node web/lib/perms.test.mjs` can ask it.
export type PermGroup = { title: string; perms: [string, string][] };

const GROUPS: PermGroup[] = [
  {
    title: "Selling",
    perms: [
      ["sale.create", "Take orders"],
      ["payment.take", "Take payment"],
      ["sale.apply_discount", "Give a discount"],
      ["sale.apply_restricted_discount", "Give a discount that needs a manager"],
      ["sale.void_line", "Delete an item before it is sent to the kitchen"],
      ["sale.void_sent_line", "Void an item after it was sent"],
      ["sale.refund", "Refund a receipt"],
      ["payment.correct", "Correct the payment type on a paid bill"],
    ],
  },
  {
    title: "Orders and tables",
    perms: [
      ["ticket.view_all", "See everyone's orders"],
      ["ticket.reassign", "Change the waiter on an order"],
      ["ticket.split_merge", "Transfer an order to another table"],
      ["items.availability", "Mark an item sold out or back on sale on the till"],
    ],
  },
  {
    title: "Cash",
    perms: [
      ["drawer.open_no_sale", "Open the cash drawer without a sale"],
      ["cash.pay_in_out", "Put cash in and take cash out"],
      ["shift.open_close", "Open the day and close it, count the drawer"],
      ["shift.view_report", "See the day's figures on the till"],
    ],
  },
  {
    title: "Receipts",
    perms: [
      ["receipts.view_all", "See all receipts and the day’s payments"],
      ["receipts.reprint", "Reprint receipts, bills and kitchen orders"],
    ],
  },
  {
    title: "Back office",
    perms: [
      ["backoffice.access", "Sign in to the back office"],
      ["reports.view", "See reports"],
      ["items.edit", "Edit the menu, taxes and stock"],
      ["employees.edit", "Manage staff and roles"],
      ["settings.device", "Change settings, printers and tables; change how a till is set up and sign it out"],
    ],
  },
];

// A shop's stock has permissions of its own (migration 0073). A restaurant's
// stock stays under "Edit the menu, taxes and stock".
const STOCK: PermGroup = {
  title: "Stock",
  perms: [
    ["stock.view", "See stock and its movements"],
    ["stock.receive", "Order from suppliers and receive deliveries, with their costs"],
    ["stock.adjust", "Adjust stock: damaged, lost, found"],
    ["stock.count", "Run stock counts"],
    ["suppliers.edit", "Manage suppliers"],
    ["costs.view", "See cost and profit"],
  ],
};

// What one kind of business is offered. For a shop, editing the catalog no
// longer covers its stock, and is worded so; selling is worded for a counter
// with no kitchen behind it, and has one right more: changing the price of
// one line of a sale (migration 0077; only a shop's till offers it).
export function permGroups(mode: Mode): PermGroup[] {
  if (mode !== "retail") return GROUPS;
  const said: Record<string, string> = {
    "items.edit": "Edit the catalog, taxes and discounts",
    "sale.create": "Ring up sales",
    "sale.apply_discount": "Give a discount, on a sale or on one line",
    "sale.void_line": "Take a line off a sale",
  };
  const more: Record<string, [string, string][]> = { "sale.apply_restricted_discount": [["sale.change_price", "Change the price of one line of a sale"]] };
  return [...GROUPS.map((g) => ({ ...g, perms: g.perms.flatMap(([k, label]): [string, string][] => [[k, said[k] ?? label], ...(more[k] ?? [])]) })), STOCK];
}

// What a role holds after its form is saved: the ticks among what the page
// offered, and everything the role held that the page does not show (a
// permission of the other kind of business, or one added since).
export function savedPerms(mode: Mode, had: string[], ticked: string[]): string[] {
  const known = new Set(permGroups(mode).flatMap((g) => g.perms.map(([k]) => k)));
  return [...new Set([...had.filter((p) => !known.has(p)), ...ticked.filter((p) => known.has(p))])];
}
