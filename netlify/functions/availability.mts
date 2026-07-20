import type { Context, Config } from "@netlify/functions";

// Server-side relay for Vara's Airbnb availability calendar.
// Fetches the .ics feed from Airbnb on the server (avoiding the browser CORS
// block) and hands it back to the site's JS. Replaces the old dependency on
// a free public CORS proxy, which was unreliable and would silently fail,
// making the calendar show all dates as available even when they were booked.
//
// To point this at a different Airbnb listing/export link in future:
// Airbnb -> Listing -> Calendar -> Availability -> "Connect to another website" ->
// "Export Calendar", copy the .ics link, and paste it below.
const AIRBNB_ICAL_URL =
"https://www.airbnb.co.in/calendar/ical/1458594287121129153.ics?t=c5800038f27447908e1f73a96fe96918";

export default async (req: Request, context: Context) => {
try {
const resp = await fetch(AIRBNB_ICAL_URL, {
headers: { "User-Agent": "Mozilla/5.0 (compatible; VaraAvailabilityBot/1.0)" },
});

if (!resp.ok) {
return new Response("Upstream calendar fetch failed: " + resp.status, {
status: 502,
});
}

const text = await resp.text();

return new Response(text, {
status: 200,
headers: {
"Content-Type": "text/calendar; charset=utf-8",
"Cache-Control": "public, max-age=1800",
},
});
} catch (err) {
return new Response("Fetch failed", { status: 502 });
}
};

export const config: Config = {
path: "/api/availability",
};
