# EasyPay, the public site

The page people see at easypaypos.com. Plain HTML, CSS and one script: no
framework, no build step, nothing to install. It is separate from the back
office (`web/`), which keeps its own address.

```
index.html      the page
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
- `signInUrl`: the back office's sign-in page. While it is empty the
  "Sign in" links are hidden.

The form has no server behind it. It writes the message and opens the
visitor's own e-mail app (or WhatsApp) to send it.

## What the page may say

Only what the till and the back office do today (`android/README.md` lists
it, with what is not built). No prices, customer names, figures or reviews
are on the page, because there are none to quote yet. The screens in the
page are drawn in HTML from the app's own colours (`core/ui/V2.kt`), with a
sample menu; real screenshots can replace them.

## Hosting

Any static host serves the folder as it is. Point the host at `site/` with
no build command.
