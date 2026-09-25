/**
 * Geocoding and distance.
 *
 * Turning "Apex, NC" into coordinates needs a geocoder, and every commercial
 * one wants a key and a credit card. Three free, keyless services cover this
 * app's needs, tried in order:
 *
 *   1. Zippopotam.us       — a bare 5-digit ZIP code.
 *   2. Open-Meteo geocoding — a town name, "Greenville, NC". Free for
 *      non-commercial use with no key, which fits a school project.
 *   3. US Census Geocoder  — a full STREET address. It only matches street
 *      addresses: asked for "Greenville, NC" it returns no match at all,
 *      which is why it can't be the only lookup for a "City and state" field.
 *
 * If all of them fail — offline, rate limited, a place nobody recognises —
 * geocoding returns null and the app carries on without distances rather
 * than failing the request. That is the important property: coordinates are
 * an enhancement here, never a requirement.
 *
 * A small offline table covers the towns in the seed data so that seeding a
 * fresh database never depends on the network.
 */

const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const ZIPPO = "https://api.zippopotam.us/us";
const OPEN_METEO = "https://geocoding-api.open-meteo.com/v1/search";

/** Towns in the seed data, so `npm run seed` works with no network. */
const KNOWN = {
  "apex, nc":         [35.7327, -78.8503],
  "raleigh, nc":      [35.7796, -78.6382],
  "durham, nc":       [35.9940, -78.8986],
  "cary, nc":         [35.7915, -78.7811],
  "garner, nc":       [35.7113, -78.6142],
  "clayton, nc":      [35.6507, -78.4564],
  "smithfield, nc":   [35.5085, -78.3395],
  "rocky mount, nc":  [35.9382, -77.7905],
  "fayetteville, nc": [35.0527, -78.8784],
  "charlotte, nc":    [35.2271, -80.8431],
  "jamestown, nc":    [35.9985, -79.9350],
  "sanford, nc":      [35.4799, -79.1803],
  "wilmington, nc":   [34.2257, -77.9447],
  "greensboro, nc":   [36.0726, -79.7920],
  "winston-salem, nc":[36.0999, -80.2442],
  "asheville, nc":    [35.5951, -82.5515],
  "wilson, nc":       [35.7213, -77.9155],
  "goldsboro, nc":    [35.3849, -77.9928],
  "chapel hill, nc":  [35.9132, -79.0558],
  "wake forest, nc":  [35.9799, -78.5097],
  "holly springs, nc":[35.6513, -78.8336],
  "morrisville, nc":  [35.8235, -78.8256],
  "knightdale, nc":   [35.7877, -78.4808],
  "fuquay-varina, nc":[35.5843, -78.8000]
};

/* Found coordinates are cached for the life of the process. Failures are only
   cached briefly: a lookup that failed because the network blipped should be
   retried soon, not remembered as "this town doesn't exist" until a restart. */
const cache = new Map();
const MISS_TTL_MS = 10 * 60 * 1000;

/* Feeds spell states both ways — "Durham, NC" and "Durham, North Carolina" —
   and a lookup table keyed one way silently misses the other. Normalizing to
   the postal abbreviation makes both hit. */
const STATE_ABBR = {
  "alabama":"al","alaska":"ak","arizona":"az","arkansas":"ar","california":"ca","colorado":"co",
  "connecticut":"ct","delaware":"de","florida":"fl","georgia":"ga","hawaii":"hi","idaho":"id",
  "illinois":"il","indiana":"in","iowa":"ia","kansas":"ks","kentucky":"ky","louisiana":"la",
  "maine":"me","maryland":"md","massachusetts":"ma","michigan":"mi","minnesota":"mn",
  "mississippi":"ms","missouri":"mo","montana":"mt","nebraska":"ne","nevada":"nv",
  "new hampshire":"nh","new jersey":"nj","new mexico":"nm","new york":"ny",
  "north carolina":"nc","north dakota":"nd","ohio":"oh","oklahoma":"ok","oregon":"or",
  "pennsylvania":"pa","rhode island":"ri","south carolina":"sc","south dakota":"sd",
  "tennessee":"tn","texas":"tx","utah":"ut","vermont":"vt","virginia":"va",
  "washington":"wa","west virginia":"wv","wisconsin":"wi","wyoming":"wy",
  "district of columbia":"dc"
};
const ABBR_STATE = Object.fromEntries(Object.entries(STATE_ABBR).map(([name, abbr]) => [abbr, name]));

function clean(value) {
  let s = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  // "Cary, North Carolina, United States" -> "cary, nc"
  s = s.replace(/,\s*(united states|usa|us)$/, "");
  for (const [name, abbr] of Object.entries(STATE_ABBR)) {
    s = s.replace(new RegExp(`,\\s*${name}$`), `, ${abbr}`);
  }
  return s;
}

async function fetchJson(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "anvil-trades-portal/1.0 (school project)" }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // offline, timed out, rate limited — all the same to us
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "Greenville, NC" -> the best-matching town, or null.
 * The search takes a bare name, so the state is used to pick among the many
 * Greenvilles; with no state given, the most populous match wins.
 */
async function lookupTown(key) {
  // "greenville, nc" or "greenville nc" -> town + state; "greenville" -> town only.
  let town = key, state = null;
  const m = key.match(/^(.+?),?\s+([a-z]{2})$/);
  if (m && ABBR_STATE[m[2]]) [, town, state] = m;
  else if (key.includes(",")) return null;   // "somewhere, xx" with a non-state suffix

  const url = `${OPEN_METEO}?name=${encodeURIComponent(town)}&count=10&language=en&format=json&countryCode=US`;
  const data = await fetchJson(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  const wantState = state ? ABBR_STATE[state] : null;
  const hit = results.find(r =>
    String(r.name || "").toLowerCase() === town &&
    (!wantState || String(r.admin1 || "").toLowerCase() === wantState)
  );
  return hit ? validCoords(hit.latitude, hit.longitude) : null;
}

/**
 * "Apex, NC", "27502" or "1 Main St, Raleigh, NC" -> { latitude, longitude } or null.
 * Never throws; callers treat null as "no coordinates, carry on".
 */
export async function geocode(place) {
  const key = clean(place);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && (cached.point || Date.now() < cached.retryAfter)) return cached.point;

  let found = null;

  if (KNOWN[key]) {
    found = { latitude: KNOWN[key][0], longitude: KNOWN[key][1] };
  }

  // A ZIP code on its own, or at the end ("Raleigh, NC 27601").
  const zip = key.match(/(?:^|\s)(\d{5})(?:-\d{4})?$/)?.[1];
  if (!found && zip) {
    const data = await fetchJson(`${ZIPPO}/${zip}`);
    const p = data?.places?.[0];
    if (p) found = validCoords(p.latitude, p.longitude);
  }

  // A town name: no digits, at most one comma ("Wake Forest, NC").
  const looksLikeTown = !/\d/.test(key) && (key.match(/,/g) || []).length <= 1;
  if (!found && looksLikeTown) {
    found = await lookupTown(key);
  }

  // Anything with a house number is treated as a street address. Town names
  // never go here — the Census geocoder can't match them.
  if (!found && /\d/.test(key) && !zip) {
    const url = `${CENSUS}?address=${encodeURIComponent(String(place))}&benchmark=Public_AR_Current&format=json`;
    const data = await fetchJson(url);
    const match = data?.result?.addressMatches?.[0]?.coordinates;
    if (match) found = validCoords(match.y, match.x);
  }

  cache.set(key, { point: found, retryAfter: Date.now() + MISS_TTL_MS });
  return found;
}

/**
 * Great-circle distance in miles.
 *
 * Computed in JavaScript rather than SQL on purpose: SQLite has no trig
 * functions without a compiled extension, and Postgres would need earthdistance
 * or PostGIS. Doing it here keeps one code path for both engines, and the
 * result sets this app sorts are small enough that the cost is irrelevant.
 */
export function milesBetween(aLat, aLon, bLat, bLon) {
  if ([aLat, aLon, bLat, bLon].some(v => v === null || v === undefined || Number.isNaN(Number(v)))) {
    return null;
  }
  const R = 3958.8; // Earth's mean radius, miles
  const toRad = d => (Number(d) * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/**
 * Attach `distance_miles` to each row relative to an origin, and optionally
 * sort by it. Rows with no coordinates keep a null distance and sort last —
 * an unknown location should not masquerade as a far one, or as a near one.
 */
export function withDistance(rows, origin, { sort = false } = {}) {
  if (!origin || origin.latitude == null || origin.longitude == null) {
    return rows.map(r => ({ ...r, distance_miles: null }));
  }
  const out = rows.map(r => ({
    ...r,
    distance_miles: milesBetween(origin.latitude, origin.longitude, r.latitude, r.longitude)
  }));
  if (sort) {
    out.sort((a, b) => {
      if (a.distance_miles == null) return 1;
      if (b.distance_miles == null) return -1;
      return a.distance_miles - b.distance_miles;
    });
  }
  return out;
}

/**
 * Valid WGS84 coordinates, or null. Used to vet anything client-supplied.
 *
 * Only real numbers (or numeric strings) count. Number(null) and Number("")
 * are both 0, so without this check an empty value became 0,0 — a point in
 * the Atlantic off West Africa — and every distance read about 5,000 miles.
 */
const numeric = v =>
  typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));

export function validCoords(lat, lon) {
  if (!numeric(lat) || !numeric(lon)) return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { latitude: la, longitude: lo };
}
