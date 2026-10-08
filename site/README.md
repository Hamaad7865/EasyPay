# EasyPay, the public site

The page people see at easypaypos.pages.dev. Plain HTML, CSS and one script:
no framework, no build step, nothing to install. The back office (`web/`) is
a separate program served under the same address (see Hosting).

The address is written out in `index.html` (the canonical link, the tags a
shared link is previewed from, the footer) and in `404.html`. easypaypos.com
is not registered yet: the day it is, and points here, those are the lines
to change.

```
index.html      the page
404.html        what an address with nothing behind it answers
css/site.css    the page's look, top to bottom
css/mock.css    the product drawn in the page: tablet, paper, back office window
js/config.js    the site's own details (see below)
js/main.js      the bar, the dots, the tablet's screens, the demo form
assets/         the logo, cut down from brand/ (never redrawn)
```

## See it

```
python -m http.server 4173 --directory site
```

then open http://localhost:4173.

## Before it goes live

Everything to fill in is in `js/config.js`:

- `email`: where "Book a demo" messages go. It says `hello@easypaypos.com`,
  which is a guess: the mailbox has to exist.
- `whatsapp`: the number in international form, digits only. While it is
  empty the WhatsApp button is hidden.
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

## Hosting

It is the Cloudflare Pages project `easypaypos`, at easypaypos.pages.dev,
which serves this folder as it is, with no build step. Two files here are
not part of the site and are not served: `_worker.js` hands the back
office's addresses (`/login`, `/backoffice`, `/admin` and what they need) to
the back office's own Worker, so that easypaypos.pages.dev/login is the
sign-in, and `_routes.json` lists those addresses so a visit to the site
runs no code at all. `../cloudflare/pages/wrangler.toml` is the project's
configuration.

It goes live with the "release to production" workflow
(`.github/workflows/deploy.yml`, last step), or by hand from
`cloudflare/pages`: `npx wrangler pages deploy --branch restopos`.

Any other static host still serves the folder as it is; the sign-in links
then need the back office's full address in `js/config.js`.
