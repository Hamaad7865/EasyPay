# EasyPay, the public site

The page people see at easypaypos.com. Plain HTML, CSS and one script:
no framework, no build step, nothing to install. The back office (`web/`) is
a separate program served under the same address (see Hosting).

The address is written out in `index.html` (the canonical link, the tags a
shared link is previewed from, the footer) and in `404.html`. The same pages
also answer at easypaypos.pages.dev, the Cloudflare project's own address;
the canonical link tells a search engine which of the two is the site.

```
index.html      the page
404.html        what an address with nothing behind it answers
css/site.css    the page's look, top to bottom
css/mock.css    the product drawn in the page: tablet, paper, back office window
js/config.js    the site's own details (see below)
js/main.js      the bar, the choice, the dots, the tablet's film, the demo form
assets/         the logo, cut down from brand/ (never redrawn)
```

## A restaurant's page or a shop's

One page shows either. `<html data-for="restaurant|shop">` says which, and
anything marked `data-only="restaurant"` or `data-only="shop"` is shown for
that one only; what is said to both carries no mark. The visitor picks in the
hero. A link to a section that belongs to one of them shows that one first,
and `/#shop` opens the page for a shop, so that address can be sent to a shop
owner. The choice is kept on the visitor's device.

Adding something for one of them is a matter of marking it. A sentence that
differs by a word holds two spans, one for each.

## The film

The tablet in the hero plays a sale by itself: five chapters for a
restaurant, four for a shop, each with a line under the tablet saying what
is happening, a key that jumps to it and a Pause key. A chapter is a short
list of steps in `js/main.js` (say, tap, change the screen, wait). It first
puts its screens back as they are written in `index.html`, so what is in the
page is also what a visitor sees who asked their device for less motion: for
them nothing moves, and the keys still turn the screens.

The film plays only while the tablet is on screen and the tab is in front.
To watch it while working on it, the browser's window has to be showing:
in a hidden pane it rightly stands still.

## See it

```
python -m http.server 4173 --directory site
```

then open http://localhost:4173.

## Before it goes live

Everything to fill in is in `js/config.js`:

- `email`: where "Book a demo" messages go. It says `hello@easypaypos.com`,
  which is a guess: the mailbox has to exist.
- `whatsapp`: the number people reach EasyPay on, by WhatsApp or by calling
  it, in international form, digits only. It is 230 5252 5270, given by the
  owner. It puts "Send on WhatsApp" on the demo form, the number under the
  form and the number in the foot; emptied, all three are hidden.
- `signInUrl`: the back office's sign-in page. It is `/login`: the site and
  the back office share one address (see Hosting). Emptied, the "Sign in"
  links are hidden.

The form has no server behind it. It writes the message and opens the
visitor's own e-mail app (or WhatsApp) to send it.

## What the page may say

Only what the till and the back office do today (`android/README.md` lists
it, with what is not built). No prices, customer names, figures or reviews
are on the page, because there are none to quote yet. The screens in the
page are drawn in HTML from the app's own colours (`core/ui/V2.kt`), with a
sample menu; real screenshots can replace them.

For a shop the source is the till's own Help for a shop (`SHOP_HELP` in
`feature/settings/SettingsScreen.kt`), written from its screens, and the
back office's menu for a shop (`web/app/backoffice/nav.ts`). Not said of a
shop, because not built or not whole: scanning with the tablet's camera, a
card terminal driven by the till, transfers between shops, and the three
languages (a shop's screens are only partly translated). When a shop's
screen changes, its Help changes, and this page is read against it again.

## Hosting

It is the Cloudflare Pages project `easypaypos`, with easypaypos.com as its
custom domain (set in Cloudflare, under the project's Custom domains),
which serves this folder as it is, with no build step. Two files here are
not part of the site and are not served: `_worker.js` hands the back
office's addresses (`/login`, `/backoffice`, `/admin` and what they need) to
the back office's own Worker, so that easypaypos.com/login is the
sign-in, and `_routes.json` lists those addresses so a visit to the site
runs no code at all. `../cloudflare/pages/wrangler.toml` is the project's
configuration.

It goes live with the "release to production" workflow
(`.github/workflows/deploy.yml`, last step), or by hand from
`cloudflare/pages`: `npx wrangler pages deploy --branch restopos`.

Any other static host still serves the folder as it is; the sign-in links
then need the back office's full address in `js/config.js`.
