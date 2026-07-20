# Vara website — how to use & publish (free)

Your site is one folder: `vara-website/` containing `index.html`, the `img/` photos, and `thanks.html`. Keep them together. (There's also a `netlify/functions/` folder — a more robust version of the availability sync that only works if you connect this site to GitHub instead of drag-and-drop; see the note at the bottom of the calendar section below. You can ignore it for now.)

## Preview it now
Double-click `index.html` — it opens in your browser. Everything works offline, including the WhatsApp buttons.

## Put it online for free (no cost)

**Easiest — Netlify Drop (2 minutes, no account needed to try):**
1. Go to https://app.netlify.com/drop
2. Drag the whole `vara-website` folder onto the page.
3. You instantly get a free live link like `vara-goa.netlify.app`. Sign up (free) to keep it and rename it.

**Alternative — Cloudflare Pages or GitHub Pages:** both host static sites like this for free. Netlify Drop is the simplest.

**Custom domain (optional):** if you buy a domain (e.g. `varagoa.com`), you can point it at the free Netlify site later — hosting stays free, you only pay for the domain.

## The Book button
Every "Book" button opens WhatsApp with a chat to **+91 98102 14817** and a pre-filled message asking for dates and guests.

To change the number or message, open `index.html`, scroll to the bottom `<script>` block, and edit:
- `WA_NUMBER` — country code + number, no `+`, spaces or dashes (currently `919810214817`).
- `WA_MESSAGE` — the pre-filled text guests see.

## Availability calendar (sync with Airbnb)
The site has a live calendar. Guests pick check-in/check-out and the "Book these dates" button sends those dates to your WhatsApp. Booked dates block automatically, synced from your Airbnb calendar.

Browsers aren't allowed to read Airbnb's calendar file directly (a security restriction called CORS), so the page fetches it through a public relay service instead. Those relays are free but have no uptime guarantee — one of them (the only one the earlier version of this site used) went down and silently made every date look available, which is what you ran into. The current version tries three different relays in order, and if all three are down, it falls back to the last successfully-synced calendar (saved in the guest's browser) with a note showing how old that data is, rather than ever quietly claiming every date is free.

If you ever need to point this at a different Airbnb listing (e.g. you relist, or add a second property):
1. In Airbnb: open the listing → **Calendar** → **Availability** → **Connect to another website** → **Export Calendar**, and copy the link (it ends in `.ics`).
2. Open `index.html`, find `var AIRBNB_ICAL_URL = "..."` near the bottom, and paste the new link between the quotes.
3. Save and re-upload.

Note: the calendar shows availability but does **not** take payment or lock a booking — you confirm each one on WhatsApp.

**A more solid version exists but isn't active yet.** `netlify/functions/availability.mts` fetches Airbnb's calendar from Netlify's own servers instead of a public relay — no reliability gamble at all. The catch: Netlify only runs that kind of function for sites deployed via GitHub or the Netlify CLI, not the drag-and-drop upload this guide uses. If you ever want to move to GitHub-based deploys (worth it if this site keeps growing), say so and I'll wire it up — it'll also mean edits go live from a "push to GitHub" step instead of re-uploading a zip each time.

## Location map
A Google Map pinned to Riviera Foothills, Arpora is embedded in the Location section, with a "Get directions" button. No setup or API key needed. If you want the pin on the exact building instead of the complex, send me a Google Maps link to the spot and I'll drop it in.

## thanks.html
This is your existing "details received" confirmation page — kept in the folder in case you want to link it after a form later. It isn't linked from the main site yet.
