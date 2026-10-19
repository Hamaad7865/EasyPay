// A made-up restaurant's menu in the shape a till publishes it: the one the
// guest page was designed on (Le Flamboyant). Used by the tests and by the
// stand-in till. Prices are in cents.

const spice = (id, name) => ({ id, name, min: 1, max: 1, opts: ["No chili", "Mild", "Medium", "Hot"].map((n, i) => ({ id: id + i, name: n, price: 0 })) });
const group = (id, name, min, max, opts) => ({ id, name, min, max, opts: opts.map(([n, p], i) => ({ id: id + i, name: n, price: p })) });

const GROUPS = [
  spice("cs", "Curry spice"),
  group("ca", "Curry add-ons", 0, 3, [["Extra rice", 4000], ["Extra chutney", 2500], ["Fried egg", 3000]]),
  spice("ss", "Street spice"),
  group("sa", "Street add-ons", 0, 3, [["Extra rougaille", 2500], ["Extra chutney", 1500], ["Achard", 2000]]),
  spice("ws", "Wok spice"),
  group("wa", "Wok add-ons", 0, 3, [["Fried egg", 3000], ["Extra chicken", 9000], ["Extra sauce", 2000]]),
  group("ck", "Cooking", 1, 1, [["Rare", 0], ["Medium", 0], ["Well done", 0]]),
  group("sd", "Side", 0, 1, [["Frites", 0], ["Légumes sautés", 0], ["Riz blanc", 0]]),
  group("fs", "Fish side", 0, 1, [["Riz blanc", 0], ["Frites", 0], ["Légumes sautés", 0]]),
  group("ic", "Ice", 0, 1, [["Normal ice", 0], ["Less ice", 0], ["No ice", 0]]),
  group("ms", "Measure", 1, 1, [["Single", 0], ["Double", 15000]]),
];
const SETS = { curry: ["cs", "ca"], street: ["ss", "sa"], wok: ["ws", "wa"], steak: ["ck", "sd"], fish: ["fs"], ice: ["ic"], measure: ["ms"] };

// [category, its colour, [id, name, cents, option set, "v" vegetarian | "x" sold out]]
const RAW = [
  ["Starters", "#c9a227", [["gp", "Gateaux piments (6)", 9500, null, "v"], ["sam", "Samoussa (6)", 11000], ["pal", "Salade de palmiste", 29000, null, "v"], ["soup", "Soupe de crabe", 26000], ["crev", "Crevettes sautées à l'ail", 35000]]],
  ["Street food", "#d9822b", [["dp", "Dholl puri", 5000, "street", "v"], ["far", "Farata rougaille", 8500, "street", "v"], ["mb", "Mine bouillie", 9000, "street"], ["arr", "Gato arouille (6)", 8000, "street", "v"]]],
  ["Curries & mains", "#c4523a", [["cp", "Cari poulet", 38000, "curry"], ["rs", "Rougaille saucisse", 32000, "curry"], ["cou", "Cari ourite", 45000, "curry"], ["vin", "Vindaye de poisson", 42000, "curry"], ["bp", "Briyani poulet", 42000, "curry"], ["bm", "Briyani mouton", 48000, "curry"], ["sf", "Steak frites", 59000, "steak"], ["mag", "Magret de canard", 72000, "steak"]]],
  ["Rice & noodles", "#3f8443", [["mf", "Mine frire poulet", 28000, "wok"], ["rfc", "Riz frit crevettes", 31000, "wok"], ["br", "Bol renversé", 34000, "wok"], ["sv", "Sauté de légumes", 24000, "wok", "v"], ["pas", "Porc aigre-doux", 36000, "wok"]]],
  ["Grill & seafood", "#2f7fa3", [["pg", "Poisson grillé (capitaine)", 65000, "fish"], ["cam", "Camarons grillés", 78000, "fish"], ["lang", "Langouste grillée", 145000, "fish"], ["cal", "Calamars frits", 42000, null, "x"]]],
  ["Desserts", "#b8478f", [["gpat", "Gâteau patate", 14000, null, "v"], ["cb", "Crème brûlée vanille", 22000, null, "v"], ["sfr", "Salade de fruits", 16000, null, "v"], ["gc", "Glace coco", 15000, null, "v"], ["nap", "Napolitaine", 7000, null, "v"]]],
  ["Drinks", "#2a9d8f", [["alo", "Alouda", 9000, "ice"], ["the", "Thé vanille", 8000], ["eau", "Eau Cristal 50cl", 4000], ["coke", "Coca-Cola", 6000], ["ana", "Jus d'ananas", 11000, "ice"], ["las", "Lassi", 12000, "ice"]]],
  ["Bar", "#6c4fb3", [["pho", "Phoenix 330ml", 16000], ["tpu", "Ti punch", 30000, "measure"], ["ra", "Rhum arrangé", 26000, "measure"], ["pc", "Piña colada", 38000], ["gt", "Gin tonic", 34000, "measure"], ["vr", "Vin rouge (verre)", 28000]]],
];

export function demoMenu() {
  const categories = [], items = [];
  RAW.forEach(([name, color, list], n) => {
    const cat = "c" + n;
    categories.push({ id: cat, name, color });
    for (const [id, itemName, price, set, mark] of list) {
      items.push({ id, cat, name: itemName, price, groups: set ? SETS[set] : [], tags: mark === "v" ? ["Veg"] : [], out: mark === "x" });
    }
  });
  return {
    name: "Le Flamboyant",
    currency: "Rs",
    decimals: 2,
    note: "Prices in Mauritian rupees, VAT included.",
    accepting: true,
    tables: [
      { c: T1, name: "Table 1", area: "Main room" },
      { c: T7, name: "Table 7", area: "Terrace" },
      { c: T12, name: "Table 12", area: "Terrace" },
    ],
    categories,
    groups: structuredClone(GROUPS), // a copy: whoever changes a menu changes their own
    items,
    popular: ["cp", "dp", "mf", "bp", "alo"],
  };
}

// a table's code on its card is its id, whole
export const T1 = "5f0c2a9e-0001-4a11-8c01-000000000001";
export const T7 = "5f0c2a9e-0007-4a11-8c01-000000000007";
export const T12 = "5f0c2a9e-0012-4a11-8c01-000000000012";

// The stand-in till's store, and the credential a stand-in gives: never a
// real store's or a real till's. test/stand-in-api.mjs reads the store off the
// credential itself, as EasyPay's till service would look it up.
export const DEMO_STORE = "demostoreaaaaaaa";
// `till` tells two tills of one store apart: "Device <store>.<till>:..."
export const proofFor = (store, word = "good", till = "") => `Device ${store}${till ? "." + till : ""}:${word}-stand-in-credential`;
