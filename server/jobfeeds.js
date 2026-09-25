/**
 * Importing real job postings from outside feeds.
 *
 * Two adapters, both optional — with no keys configured the app runs exactly
 * as before, on employer-posted jobs only:
 *
 *   Adzuna         ADZUNA_APP_ID + ADZUNA_APP_KEY   (free tier, self-serve)
 *   CareerOneStop  COS_USER_ID + COS_TOKEN          (US Dept of Labor, free)
 *
 * Both return the same normalized row shape, so `syncJobs` doesn't care which
 * one produced what. Adding a third feed means adding one function here.
 *
 * THE RULE THAT MATTERS: an imported job is never applied to through this app.
 * There is no employer account behind it to receive the application, so the
 * database marks it `source <> 'employer'` and the UI links out instead. The
 * alternative — letting a student press Apply on a job we merely copied — puts
 * applications somewhere nobody will ever read them.
 */
import { all, get, run, nextId, nowStamp, retryOnIdClash } from "./db.js";
import { geocode } from "./geo.js";

/** Trades we look for, and the search terms that find them in a job feed. */
export const FEED_QUERIES = [
  { trade: "Electrical",               query: "electrician apprentice" },
  { trade: "Welding & Fabrication",    query: "welder fabricator" },
  { trade: "HVAC/R",                   query: "hvac technician" },
  { trade: "Plumbing & Pipefitting",   query: "plumber pipefitter" },
  { trade: "Diesel & Heavy Equipment", query: "diesel technician" },
  { trade: "CNC Machining",            query: "cnc machinist" },
  { trade: "Solar PV",                 query: "solar installer" },
  { trade: "Automotive",               query: "automotive technician" }
];

export const adzunaConfigured = () =>
  Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
export const careerOneStopConfigured = () =>
  Boolean(process.env.COS_USER_ID && process.env.COS_TOKEN);
export const anyFeedConfigured = () => adzunaConfigured() || careerOneStopConfigured();

async function fetchJson(url, opts = {}, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { Accept: "application/json", "User-Agent": "anvil-trades-portal/1.0", ...(opts.headers || {}) }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Imported listings not seen in a sync for this long are removed. */
const MAX_AGE_DAYS = Number(process.env.FEED_MAX_AGE_DAYS || 30);

/**
 * Only plain web links are stored. The link is rendered as an "Apply on their
 * site" button, and a feed is someone else's data: a `javascript:` URL there
 * would run in a student's browser when they clicked it.
 */
function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Money comes back from feeds in several shapes; normalize to one string. */
function wageRange(min, max) {
  const fmt = n => "$" + Math.round(Number(n)).toLocaleString("en-US");
  const lo = Number(min), hi = Number(max);
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi > 0) {
    return lo === hi ? `${fmt(lo)}/yr` : `${fmt(lo)}-${fmt(hi)}/yr`;
  }
  if (Number.isFinite(lo) && lo > 0) return `from ${fmt(lo)}/yr`;
  if (Number.isFinite(hi) && hi > 0) return `up to ${fmt(hi)}/yr`;
  return "Not stated";
}

/* ============================================================
   ADAPTERS
   Each returns rows of:
   { source, source_ref, title, company_name, location,
     latitude, longitude, wage_range, source_url, trade }
   ============================================================ */

async function fromAdzuna({ query, trade, where, radiusMiles, limit }) {
  const params = new URLSearchParams({
    app_id: process.env.ADZUNA_APP_ID,
    app_key: process.env.ADZUNA_APP_KEY,
    results_per_page: String(limit),
    what: query,
    where,
    distance: String(radiusMiles),
    content_type: "application/json"
  });
  const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);

  return (data.results || []).map(j => ({
    source: "adzuna",
    source_ref: String(j.id),
    title: j.title ? j.title.replace(/<[^>]+>/g, "").trim() : "Untitled role",
    company_name: j.company?.display_name || "Unnamed company",
    location: j.location?.display_name || where,
    latitude: Number.isFinite(j.latitude) ? j.latitude : null,
    longitude: Number.isFinite(j.longitude) ? j.longitude : null,
    wage_range: wageRange(j.salary_min, j.salary_max),
    source_url: safeUrl(j.redirect_url),
    trade
  }));
}

async function fromCareerOneStop({ query, trade, where, radiusMiles, limit }) {
  // Path-parameter API: /v1/jobsearch/{userId}/{keyword}/{location}/{radius}/{sortBy}/{startRecord}/{pageSize}/{days}
  const seg = s => encodeURIComponent(s);
  const url = `https://api.careeronestop.org/v1/jobsearch/${seg(process.env.COS_USER_ID)}`
    + `/${seg(query)}/${seg(where)}/${radiusMiles}/relevance/0/${limit}/30`;
  const data = await fetchJson(url, {
    headers: { Authorization: `Bearer ${process.env.COS_TOKEN}` }
  });

  return (data.Jobs || []).map(j => ({
    source: "careeronestop",
    source_ref: String(j.JvId || j.JobID || `${j.JobTitle}|${j.Company}`),
    title: (j.JobTitle || "Untitled role").trim(),
    company_name: j.Company || "Unnamed company",
    location: j.Location || where,
    latitude: null,   // this feed returns a place name, not coordinates
    longitude: null,
    wage_range: "Not stated",
    source_url: safeUrl(j.URL || j.JobURL),
    trade
  }));
}

/* ============================================================
   SYNC
   ============================================================ */

/**
 * Pull from every configured feed and upsert into job_postings.
 *
 * Idempotent: `(source, source_ref)` is unique, so re-running updates the rows
 * it already has rather than duplicating them. Rows missing a URL are dropped
 * — without somewhere to send the applicant, an imported job is useless.
 *
 * One feed failing never fails the sync; the result reports per-feed errors so
 * a bad key shows up as a message rather than a silent empty import.
 */
export async function syncJobs({
  where = process.env.FEED_LOCATION || "Raleigh, NC",
  radiusMiles = Number(process.env.FEED_RADIUS_MILES || 50),
  perQuery = Number(process.env.FEED_PER_QUERY || 5),
  queries = FEED_QUERIES
} = {}) {
  const adapters = [];
  if (adzunaConfigured()) adapters.push(["adzuna", fromAdzuna]);
  if (careerOneStopConfigured()) adapters.push(["careeronestop", fromCareerOneStop]);

  if (!adapters.length) {
    return { ran: false, reason: "No job feed is configured. Set ADZUNA_APP_ID/ADZUNA_APP_KEY or COS_USER_ID/COS_TOKEN.", imported: 0, updated: 0, errors: [] };
  }

  const errors = [];
  const collected = new Map(); // source|ref -> row, so one sync can't self-duplicate

  for (const [name, adapter] of adapters) {
    for (const { trade, query } of queries) {
      try {
        const rows = await adapter({ query, trade, where, radiusMiles, limit: perQuery });
        for (const row of rows) {
          if (!row.source_url || !row.source_ref) continue;
          collected.set(`${row.source}|${row.source_ref}`, row);
        }
      } catch (err) {
        errors.push(`${name} "${query}": ${err.message}`);
      }
    }
  }

  let imported = 0, updated = 0;

  for (const row of collected.values()) {
    // Fill in coordinates for feeds that only give a place name. Cached in
    // geo.js, so repeated towns cost one lookup per sync at most.
    if (row.latitude == null) {
      const point = await geocode(row.location);
      if (point) { row.latitude = point.latitude; row.longitude = point.longitude; }
    }

    const existing = await get(
      "SELECT job_id FROM job_postings WHERE source = ? AND source_ref = ?",
      row.source, row.source_ref
    );

    if (existing) {
      await run(
        `UPDATE job_postings
            SET title = ?, wage_range = ?, company_name = ?, location = ?,
                latitude = ?, longitude = ?, source_url = ?, imported_at = ?
          WHERE job_id = ?`,
        row.title, row.wage_range, row.company_name, row.location,
        row.latitude, row.longitude, row.source_url, nowStamp(), existing.job_id
      );
      updated++;
    } else {
      await retryOnIdClash(async () => {
        const job_id = await nextId("job_postings", "job_id", "jb");
        await run(
          `INSERT INTO job_postings
             (job_id, source, employer_id, admin_id, title, wage_range, status,
              company_name, location, latitude, longitude, source_url, source_ref, imported_at)
           VALUES (?, ?, NULL, NULL, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
          job_id, row.source, row.title, row.wage_range, row.company_name,
          row.location, row.latitude, row.longitude, row.source_url, row.source_ref, nowStamp()
        );
      });
      imported++;
    }
  }

  // Listings the feeds haven't returned for a month have almost certainly
  // closed. Left in place they'd sit on the board forever as dead links.
  // Safe to delete: an imported job can never have an application here.
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const { changes: removed } = await run(
    "DELETE FROM job_postings WHERE source <> 'employer' AND imported_at < ?", cutoff
  );

  return { ran: true, imported, updated, removed, errors, where, radiusMiles, feeds: adapters.map(a => a[0]) };
}

/** What the admin screen shows about the feed, without exposing any keys. */
export async function feedStatus() {
  const rows = await all(
    `SELECT source, COUNT(*) AS n, MAX(imported_at) AS last_import
       FROM job_postings WHERE source <> 'employer' GROUP BY source`
  );
  return {
    adzuna_configured: adzunaConfigured(),
    careeronestop_configured: careerOneStopConfigured(),
    location: process.env.FEED_LOCATION || "Raleigh, NC",
    radius_miles: Number(process.env.FEED_RADIUS_MILES || 50),
    imported: rows.map(r => ({ source: r.source, count: Number(r.n), last_import: r.last_import }))
  };
}
