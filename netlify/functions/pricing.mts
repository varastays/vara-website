import type { Context, Config } from "@netlify/functions";

// Live "Model Recommended v2" pricing for Vara's website — computed fresh on every
// request so the site always shows the same engine the ops dashboard uses, without
// ever needing a site redeploy when prices move.
//
// Two pieces of live data feed the calculation:
//  1. Learned calibration (weekday/weekend/longWeekend multipliers) — read from the
//     ops dashboard's PRICING_SNAPSHOT, which the daily ops automation keeps current.
//  2. Vara's own booked nights (for the orphan-gap discount) — read straight from the
//     same Airbnb .ics feed the availability function uses.
// Everything else (base price, floor/ceiling, seasonal + night-type multipliers,
// holiday windows, orphan-gap rule) is the same deterministic policy the dashboard
// uses, copied here so this function has no other dependencies.

const DASHBOARD_URL = "https://vara-dashboard.netlify.app/";
const AIRBNB_ICAL_URL =
  "https://www.airbnb.co.in/calendar/ical/1458594287121129153.ics?t=c5800038f27447908e1f73a96fe96918";
const DAYS_AHEAD = 270;

const PP = {
  base: 6148,
  floor: 4672,
  ceiling: 25000,
  weekendMult: 1.15,
  longWeekendMult: 1.35,
  orphanDiscount: 0.90,
  // Keyed by JS getMonth() (0=Jan): Peak Nov/Dec/Jan/Feb, Shoulder Oct/Mar,
  // Shoulder-low Apr/May, Off/Monsoon Jun-Sep.
  seasonal: { 10: 1, 11: 1, 0: 1, 1: 1, 9: 0.75, 2: 0.75, 3: 0.65, 4: 0.65, 5: 0.55, 6: 0.55, 7: 0.55, 8: 0.55 } as Record<number, number>,
};

// Mirrors the dashboard's HOLIDAY_WINDOWS — update both if the calendar changes.
const HOLIDAY_WINDOWS = [
  { n: "Independence Day", from: "2026-08-14", to: "2026-08-16" },
  { n: "Bonderam (Goa)", from: "2026-08-21", to: "2026-08-23" },
  { n: "Ganesh Chaturthi", from: "2026-09-12", to: "2026-09-15" },
  { n: "Gandhi Jayanti", from: "2026-10-02", to: "2026-10-04" },
  { n: "Diwali", from: "2026-11-06", to: "2026-11-11" },
  { n: "St. Francis Xavier (Goa)", from: "2026-12-03", to: "2026-12-06" },
  { n: "Goa Liberation Day", from: "2026-12-18", to: "2026-12-20" },
  { n: "Christmas & New Year", from: "2026-12-24", to: "2027-01-01" },
  { n: "Republic Day", from: "2027-01-23", to: "2027-01-26" },
];

function ymd(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function holidayFor(d: Date) {
  const s = ymd(d);
  return HOLIDAY_WINDOWS.find((h) => s >= h.from && s <= h.to);
}
function priceBucket(d: Date): "longWeekend" | "weekend" | "weekday" {
  if (holidayFor(d)) return "longWeekend";
  const dow = d.getDay();
  return dow === 5 || dow === 6 ? "weekend" : "weekday";
}
function shift(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Extracts a balanced {...} object literal starting right after `marker` in `text`,
// respecting string literals so semicolons/braces inside quoted strings don't confuse it.
function extractObjectLiteral(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  let i = text.indexOf("{", idx + marker.length);
  if (i === -1) return null;
  const start = i;
  let depth = 0;
  let inString: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function fetchCalibration(): Promise<{ buckets: Record<string, { calib: number }> | null; asOf: string | null; source: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(DASHBOARD_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error("dashboard fetch failed: " + resp.status);
    const html = await resp.text();
    const literal = extractObjectLiteral(html, "const PRICING_SNAPSHOT = ");
    if (!literal) throw new Error("PRICING_SNAPSHOT not found");
    const snapshot = JSON.parse(literal);
    const buckets = snapshot?.calibration?.buckets;
    if (!buckets) throw new Error("calibration.buckets missing");
    return { buckets, asOf: snapshot?.calibration?.history?.length ? snapshot.asOf ?? null : snapshot?.asOf ?? null, source: "live" };
  } catch (err) {
    return { buckets: null, asOf: null, source: "fallback (calib ×1.0 — dashboard unreachable)" };
  }
}

async function fetchBookedNights(): Promise<Set<string>> {
  const booked = new Set<string>();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(AIRBNB_ICAL_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VaraAvailabilityBot/1.0)" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return booked;
    const text = await resp.text();
    const parts = text.split("BEGIN:VEVENT");
    for (let i = 1; i < parts.length; i++) {
      const s = parts[i].match(/DTSTART[^:]*:(\d{8})/);
      const e = parts[i].match(/DTEND[^:]*:(\d{8})/);
      if (!s) continue;
      const sd = new Date(+s[1].slice(0, 4), +s[1].slice(4, 6) - 1, +s[1].slice(6, 8));
      const ed = e
        ? new Date(+e[1].slice(0, 4), +e[1].slice(4, 6) - 1, +e[1].slice(6, 8))
        : new Date(sd.getTime() + 86400000);
      for (let d = new Date(sd); d < ed; d.setDate(d.getDate() + 1)) booked.add(ymd(d));
    }
  } catch (err) {
    // no booking data — orphan-gap discount just won't apply; not fatal.
  }
  return booked;
}

function isOrphan(d: Date, booked: Set<string>): boolean {
  if (booked.size === 0) return false;
  if (booked.has(ymd(d))) return false;
  const L1 = booked.has(ymd(shift(d, -1)));
  const R1 = booked.has(ymd(shift(d, 1)));
  if (L1 && R1) return true;
  if (L1 && !R1 && booked.has(ymd(shift(d, 2)))) return true;
  if (R1 && !L1 && booked.has(ymd(shift(d, -2)))) return true;
  return false;
}

function rawPolicy(d: Date, booked: Set<string>): number {
  const mult = PP.seasonal[d.getMonth()] ?? 0.55;
  const seasonalBase = Math.min(Math.max(PP.base * mult, PP.floor), PP.ceiling);
  let p: number;
  if (holidayFor(d)) p = seasonalBase * PP.longWeekendMult;
  else if (d.getDay() === 5 || d.getDay() === 6) p = seasonalBase * PP.weekendMult;
  else p = seasonalBase;
  if (isOrphan(d, booked)) p = p * PP.orphanDiscount;
  return Math.round(Math.min(Math.max(p, PP.floor), PP.ceiling));
}

export default async (req: Request, context: Context) => {
  try {
    const [calib, booked] = await Promise.all([fetchCalibration(), fetchBookedNights()]);
    const buckets = calib.buckets;

    const priceByDate: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const bucket = priceBucket(d);
      const calibFactor = buckets && typeof buckets[bucket]?.calib === "number" && buckets[bucket].calib > 0 ? buckets[bucket].calib : 1;
      const price = Math.round(Math.min(Math.max(rawPolicy(d, booked) * calibFactor, PP.floor), PP.ceiling));
      priceByDate[ymd(d)] = price;
    }

    return new Response(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        calibrationSource: calib.source,
        calibrationAsOf: calib.asOf,
        priceByDate,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          // Cache 30 min at the edge/browser — plenty live for pricing, keeps this
          // from hammering the dashboard + Airbnb on every single visitor.
          "Cache-Control": "public, max-age=1800",
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: "pricing computation failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};

export const config: Config = {
  path: "/api/pricing",
};
