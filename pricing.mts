import type { Context, Config } from "@netlify/functions";

// Live "Model Recommended v2" pricing for Vara's website — computed fresh on every
// request so the site always shows the same engine the ops dashboard uses, without
// ever needing a site redeploy when prices move.
//
// ─────────────────────────────────────────────────────────────────────────────
// FIXED 2026-08-17. Before this date the endpoint was quoting ~19.5% BELOW Model
// Recommended on 45 of the next 49 nights (mean −Rs1,241/night), and ~28% below
// once the 10% direct discount on the page was applied on top. Five separate
// causes, all repaired here — do not undo any of them without reading why:
//
//  1. CALIBRATION WAS SILENTLY DISCARDED. The old code read
//     `buckets[bucket].calib`, but PRICING_SNAPSHOT.calibration.buckets is a map
//     of PLAIN NUMBERS ({"weekday":1.2112,...}) — that shape is mandated by the
//     ops task file. So `.calib` was `undefined`, the typeof check failed, and the
//     factor silently fell back to 1.0 while the endpoint still reported
//     calibrationSource:"live" because the fetch itself had succeeded. Costing ~21%.
//     readCalib() below now accepts BOTH shapes so neither side can break it again.
//  2. FLOOR WAS STALE. 4672 -> 5000 (booker-paid floor, changed 2026-07-30). In the
//     monsoon months the seasonal base falls under the floor, so the floor IS the
//     price on most weekday nights — this one mattered a lot.
//  3. STALE CALIBRATION SOURCE. The dashboard this reads is deliberately not
//     redeployed, so it was serving a 2026-08-05 snapshot. We now carry an embedded
//     calibration stamped with its own date and use whichever source is NEWER, so a
//     stale published dashboard can never drag prices backwards.
//  4. HOLIDAY LIST HAD DIVERGED. The old hardcoded copy still contained Ganesh
//     Chaturthi (deliberately REMOVED from the model as a stay-home festival — it
//     was adding a phantom +35% to 12-15 Sep) and was MISSING Janmashtami and
//     Dussehra entirely. We now parse HOLIDAY_WINDOWS out of the dashboard when it
//     is newer, and otherwise use the embedded copy synced 2026-08-17.
//  5. ORPHAN DISCOUNT REMOVED. Nikhil, 2026-08-09: "dont add in pricing discount,
//     it will be done on airbnb". Model Recommended is the UNDISCOUNTED rate for
//     every night. A discount baked in here would also mean the direct site
//     under-quoting against the very channel it is meant to beat.
//
//  6. OCTOBER WAS STILL PRICED AS SHOULDER + NO ANNUAL ESCALATION (found 2026-08-20,
//     during deploy prep — the 2026-08-17 pass did not catch these). Two leftovers
//     from the PRE-v5 policy, both verified against the dashboard's own rawPolicy():
//       (a) seasonal[9] (October) was 0.75. The v5 policy of 2026-07-30 folded
//           October into the Oct-Feb peak season at 1.0. Every October night was
//           therefore quoted ~19.5% BELOW Model Recommended (Rs1,358-1,962/night) —
//           the very same signature, and very nearly the same magnitude, as the
//           original bug this file was written to fix.
//       (b) The 6%/yr escalation on base AND floor (also v5, from 2026-07-30) was
//           absent. The dashboard clamps at floor*escFactor(d); this clamped at a
//           flat floor, costing a further ~1.1-1.3% and growing with the horizon.
//     With both repaired the endpoint reproduces the dashboard's Model Recommended
//     EXACTLY on all 60 verified nights. Do not "simplify" escFactor away.
//
// NOTE the page applies its own 10% direct-booking discount (VARA_BOOKING.policy
// .directDiscountPct) on top of whatever this returns. That is deliberate and is
// left alone — but it is why this endpoint must return the CLEAN model rate.
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_URL = "https://vara-dashboard.netlify.app/";
const AIRBNB_ICAL_URL =
  "https://www.airbnb.co.in/calendar/ical/1458594287121129153.ics?t=c5800038f27447908e1f73a96fe96918";
const DAYS_AHEAD = 270;

const PP = {
  base: 6148,
  floor: 5000,
  ceiling: 25000,
  weekendMult: 1.15,
  longWeekendMult: 1.35,
  // v5 policy, 2026-07-30: base and floor both escalate 6%/yr from that date.
  annualEscalation: 0.06,
  escalateFrom: "2026-07-30",
  // Keyed by JS getMonth() (0=Jan): Peak OCT/Nov/Dec/Jan/Feb, Shoulder Mar,
  // Shoulder-low Apr/May, Off/Monsoon Jun-Sep.
  // NOTE month 9 (October) is 1.0, NOT 0.75 — see fix #6 in the header.
  seasonal: { 9: 1, 10: 1, 11: 1, 0: 1, 1: 1, 2: 0.75, 3: 0.65, 4: 0.65, 5: 0.55, 6: 0.55, 7: 0.55, 8: 0.55 } as Record<number, number>,
};

// Annual escalation on base AND floor together (v5 policy, 2026-07-30). The
// dashboard's rawPolicy()/myPrice() both apply this and clamp the lower bound at
// floor*escFactor(d), so omitting it here made every night drift low by a slowly
// growing margin (~1.1% at +30 days, ~1.3% at +60).
function escFactor(d: Date): number {
  const from = new Date(PP.escalateFrom + "T00:00:00");
  const yrs = (d.getTime() - from.getTime()) / (365.25 * 864e5);
  return yrs <= 0 ? 1 : Math.pow(1 + PP.annualEscalation, yrs);
}

type Holiday = { n: string; from: string; to: string };

// Embedded fallbacks, synced from the ops dashboard on 2026-08-17. These are used
// when the published dashboard is unreachable OR older than this stamp (see #3).
const EMBEDDED_AS_OF = "2026-08-19";
const EMBEDDED_CALIB: Record<string, number> = {
  // Re-stamped 2026-08-20 from PRICING_SNAPSHOT.calibration.buckets (asOf
  // 2026-08-19T16:45+05:30). Previous stamp 2026-08-17 was weekday 1.2112 /
  // weekend 1.1591 / longWeekend 1.0857 — weekday had drifted -1.49% and
  // longWeekend +1.80%, both past the 1% re-stamp threshold.
  weekday: 1.1931,
  weekend: 1.1545,
  longWeekend: 1.1052,
};
const EMBEDDED_HOLIDAYS: Holiday[] = [
  { n: "Independence Day", from: "2026-08-14", to: "2026-08-15" },
  { n: "Bonderam (Goa)", from: "2026-08-22", to: "2026-08-22" },
  { n: "Janmashtami", from: "2026-09-03", to: "2026-09-05" },
  { n: "Gandhi Jayanti", from: "2026-10-01", to: "2026-10-04" },
  { n: "Dussehra", from: "2026-10-16", to: "2026-10-19" },
  { n: "Diwali", from: "2026-11-06", to: "2026-11-08" },
  { n: "St. Francis Xavier (Goa)", from: "2026-12-03", to: "2026-12-06" },
  { n: "Goa Liberation Day", from: "2026-12-18", to: "2026-12-20" },
  { n: "Christmas & New Year", from: "2026-12-24", to: "2027-01-01" },
  { n: "Republic Day", from: "2027-01-23", to: "2027-01-26" },
];

function ymd(d: Date): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function holidayFor(d: Date, windows: Holiday[]) {
  const s = ymd(d);
  return windows.find((h) => s >= h.from && s <= h.to);
}
function priceBucket(d: Date, windows: Holiday[]): "longWeekend" | "weekend" | "weekday" {
  if (holidayFor(d, windows)) return "longWeekend";
  const dow = d.getDay();
  return dow === 5 || dow === 6 ? "weekend" : "weekday";
}

// Accepts BOTH the plain-number shape ({weekday: 1.2112}) and the legacy object
// shape ({weekday: {calib: 1.2112}}). This tolerance is the whole point — the
// original bug was a reader assuming one shape and silently yielding 1.0.
function readCalib(buckets: any, bucket: string): number | null {
  if (!buckets) return null;
  const v = buckets[bucket];
  if (typeof v === "number" && isFinite(v) && v > 0) return v;
  if (v && typeof v.calib === "number" && isFinite(v.calib) && v.calib > 0) return v.calib;
  return null;
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

// Parses the dashboard's own HOLIDAY_WINDOWS array so this function never has to
// maintain a second copy of the holiday calendar. The old "update both if the
// calendar changes" comment was a manual sync that rotted within weeks.
function parseHolidayWindows(html: string): Holiday[] | null {
  const i = html.indexOf("const HOLIDAY_WINDOWS");
  if (i === -1) return null;
  const end = html.indexOf("];", i);
  if (end === -1) return null;
  const blk = html.slice(i, end);
  const re = /\{\s*n:\s*'([^']+)'\s*,\s*from:\s*'([^']+)'\s*,\s*to:\s*'([^']+)'/g;
  const out: Holiday[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(blk)) !== null) out.push({ n: m[1], from: m[2], to: m[3] });
  return out.length ? out : null;
}

async function fetchDashboard(): Promise<{ buckets: any; windows: Holiday[] | null; asOf: string | null }> {
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
    return {
      buckets: snapshot?.calibration?.buckets ?? null,
      windows: parseHolidayWindows(html),
      asOf: typeof snapshot?.asOf === "string" ? snapshot.asOf.slice(0, 10) : null,
    };
  } catch {
    return { buckets: null, windows: null, asOf: null };
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
  } catch {
    // no booking data — availability just won't be annotated; not fatal.
  }
  return booked;
}


// ── PEAK LAYER (Nikhil, 2026-11-21: "Teach model the peak", "Vara slightly above comp average") ──
// Peak nights: Model Recommended = max(base model, comp-anchor mean x 1.05). The table below is
// regenerated by the ops run (vara_peak_site_sync.py in the Vara Working Folder) from the daily
// season sweep of Jyoti / Vivek x0.90 / Vishesh Duplex. Do not hand-edit between the markers.
// PEAK_TABLE_START
const PEAK_AS_OF = "2026-11-22";
const PEAK_TABLE: Record<string, number> = {"2026-12-18": 9730, "2026-12-19": 11020, "2026-12-20": 11020, "2026-12-21": 10160, "2026-12-22": 10160, "2026-12-23": 10160, "2026-12-24": 15320, "2026-12-25": 15320, "2026-12-26": 15320, "2026-12-27": 15240, "2026-12-28": 15240, "2026-12-29": 15240, "2026-12-30": 15240, "2026-12-31": 15240, "2027-01-01": 15760, "2027-01-02": 15760, "2027-01-03": 13310, "2027-01-04": 10860, "2027-01-05": 10860, "2027-01-06": 10860, "2027-01-07": 10860, "2027-01-08": 9870, "2027-01-09": 9820, "2027-01-10": 9820, "2027-01-11": 7670, "2027-01-12": 7600, "2027-01-13": 7600, "2027-01-14": 7850, "2027-01-15": 7850};
// PEAK_TABLE_END

// Model Recommended = clamp( seasonal_base x night-type x calib, floor, ceiling ).
// There is deliberately NO orphan term — see header note 5.
function rawPolicy(d: Date, windows: Holiday[]): number {
  const mult = PP.seasonal[d.getMonth()] ?? 0.55;
  const esc = escFactor(d);
  const seasonalBase = Math.min(Math.max(PP.base * mult * esc, PP.floor * esc), PP.ceiling);
  let p: number;
  if (holidayFor(d, windows)) p = seasonalBase * PP.longWeekendMult;
  else if (d.getDay() === 5 || d.getDay() === 6) p = seasonalBase * PP.weekendMult;
  else p = seasonalBase;
  return Math.round(Math.min(Math.max(p, PP.floor * esc), PP.ceiling));
}

export default async (req: Request, context: Context) => {
  try {
    const [dash, booked] = await Promise.all([fetchDashboard(), fetchBookedNights()]);

    // Use the dashboard only when it is at least as fresh as what we ship. A
    // published dashboard that is weeks behind must not pull prices down.
    const dashIsFresh = !!dash.asOf && dash.asOf >= EMBEDDED_AS_OF;
    const liveCalibUsable =
      dashIsFresh && ["weekday", "weekend", "longWeekend"].every((b) => readCalib(dash.buckets, b) !== null);

    const calibFor = (bucket: string): number =>
      (liveCalibUsable ? readCalib(dash.buckets, bucket) : null) ?? EMBEDDED_CALIB[bucket] ?? 1;

    const windows = dashIsFresh && dash.windows ? dash.windows : EMBEDDED_HOLIDAYS;

    const calibrationSource = liveCalibUsable
      ? "live (dashboard " + dash.asOf + ")"
      : dash.asOf
      ? "embedded " + EMBEDDED_AS_OF + " (published dashboard " + dash.asOf + " is older)"
      : "embedded " + EMBEDDED_AS_OF + " (dashboard unreachable)";

    const priceByDate: Record<string, number> = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const price = Math.round(
        Math.min(
          Math.max(rawPolicy(d, windows) * calibFor(priceBucket(d, windows)), PP.floor * escFactor(d)),
          PP.ceiling
        )
      );
      priceByDate[ymd(d)] = Math.min(Math.max(price, PEAK_TABLE[ymd(d)] ?? 0), PP.ceiling);
    }

    return new Response(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        calibrationSource,
        calibrationAsOf: liveCalibUsable ? dash.asOf : EMBEDDED_AS_OF,
        holidaySource: dashIsFresh && dash.windows ? "dashboard" : "embedded " + EMBEDDED_AS_OF,
        calibration: {
          weekday: calibFor("weekday"),
          weekend: calibFor("weekend"),
          longWeekend: calibFor("longWeekend"),
        },
        peakAsOf: PEAK_AS_OF || null,
        floor: PP.floor,
        bookedNightsKnown: booked.size,
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
