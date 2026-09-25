/**
 * Anvil Trades Portal — REST API and web server.
 *
 *   npm run seed        rebuild + load demo data
 *   npm run dev         start on http://localhost:4000
 *   npm run sync:jobs   pull real postings from the configured feeds
 *
 * One process serves both the API and the built React app, so a deployment is
 * one service on one URL with no CORS.
 *
 * Auth: signup creates a profile row and a users row together; sign-in opens a
 * session row and returns a token in an httpOnly cookie. Every write checks
 * ownership per row, not just per role.
 */
import express from "express";
import cors from "cors";
import multer from "multer";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { all, get, run, tx, nextId, nowStamp, isEmpty, describe, DIALECT,
         isUniqueViolation, retryOnIdClash } from "./db.js";
import { seed, requireDemoPassword, rotateDemoPasswords, DEMO_PASSWORD } from "./seed.js";
import { geocode, withDistance, validCoords, milesBetween } from "./geo.js";
import { syncJobs, feedStatus, anyFeedConfigured } from "./jobfeeds.js";
import { extractText, analyzeResume, aiConfigured, MAX_RESUME_CHARS } from "./resume.js";
import { QUIZ, validAnswers, scoreTrades } from "./quiz.js";
import {
  hashPassword, checkPassword, passwordProblem, emailProblem,
  publicUser, attachUser, requireAuth, requireRole,
  startSession, revokeSession, revokeAllSessions, cookieOptions, COOKIE_NAME,
  ownsEmployer, ownsStudent
} from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = process.env.NODE_ENV === "production";
const PORT = process.env.PORT || 4000;

/* Production refuses to run with the published demo password — see seed.js. */
requireDemoPassword();

/* A brand-new deployment starts with an empty database. Seed it once, on boot,
   so the site is never a working app in front of empty tables. An existing
   database keeps its data; the only thing touched is a demo account still on
   the published password, which moves to DEMO_PASSWORD. */
if (await isEmpty()) {
  console.log("Empty database — seeding demo data.");
  await seed({ quiet: true });
} else {
  const rotated = await rotateDemoPasswords();
  if (rotated) console.log(`Moved ${rotated} demo account(s) off the published password.`);
}

const app = express();

// Hosts terminate TLS at a proxy; without this, req.protocol, secure cookies
// and the rate limiter's client IP are all wrong behind it.
if (PRODUCTION) app.set("trust proxy", 1);

/* The API and the web app are served from the same origin (and in development
   Vite proxies /api), so no browser ever makes a cross-origin call and CORS
   stays off. Set CORS_ORIGIN only if you host a separate frontend; it lists
   exactly which sites may call this API with credentials. Reflecting every
   origin, as a bare cors() would, lets any website make signed-in requests. */
if (process.env.CORS_ORIGIN) {
  app.use(cors({ credentials: true, origin: process.env.CORS_ORIGIN.split(",").map(s => s.trim()) }));
}
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(attachUser);

/* A small fixed-window limiter.
 *
 * Limits are counted per ACCOUNT wherever there is one, not per IP address. A
 * school's whole Wi-Fi usually shares one public address, so a per-IP limit
 * would lock out a class of 30 signing in at the same time. Sign-in is keyed
 * by email + IP and only counts FAILED attempts: that still stops someone
 * guessing a password, without penalising people who type theirs correctly.
 *
 * In-memory, so it resets on restart and is per-process. Fine for this app;
 * a multi-server deployment would move it to Redis or the database. */
function rateLimit({ windowMs, max, message, key = req => req.ip || "unknown", skipSuccessful = false }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
      if (hits.size > 5000) for (const [kk, v] of hits) if (now > v.resetAt) hits.delete(kk);
    }
    if (entry.count >= max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    entry.count++;
    if (skipSuccessful) {
      const counted = entry;
      res.on("finish", () => { if (res.statusCode < 400) counted.count--; });
    }
    next();
  };
}

const MIN = 60 * 1000;
const byAccount = req => req.user?.user_id || `ip:${req.ip}`;
const byEmail = req => `${String(req.body?.email || "").trim().toLowerCase()}|${req.ip}`;

const loginAccountLimiter = rateLimit({
  windowMs: 15 * MIN, max: 10, key: byEmail, skipSuccessful: true,
  message: "Too many wrong passwords for this account. Wait 15 minutes and try again."
});
const loginNetworkLimiter = rateLimit({
  windowMs: 15 * MIN, max: 200, skipSuccessful: true,
  message: "Too many failed sign-ins from this network. Wait a few minutes and try again."
});
const signupLimiter = rateLimit({
  windowMs: 60 * MIN, max: 100,
  message: "A lot of accounts have been created from this network in the last hour. Try again later."
});
const passwordLimiter = rateLimit({
  windowMs: 15 * MIN, max: 10, key: byAccount, skipSuccessful: true,
  message: "Too many attempts. Wait 15 minutes and try again."
});
const uploadLimiter = rateLimit({
  windowMs: 60 * MIN, max: 30, key: byAccount,
  message: "You've uploaded a lot of resumes in the last hour. Try again later."
});
const scanLimiter = rateLimit({
  windowMs: 60 * MIN, max: 20, key: byAccount,
  message: "You've run a lot of scans in the last hour. Try again later."
});
const syncLimiter = rateLimit({
  windowMs: 60 * MIN, max: 6, key: () => "feed-sync",
  message: "The job feed has been synced several times this hour. Try again later."
});

/** Report an error as clean JSON instead of a stack trace. */
function sendError(res, err) {
  // Two requests racing past the same "does it exist yet?" check — a double
  // click on Apply, two signups with one email — end at a unique constraint.
  // That is a conflict, not a crash.
  if (!err.status && isUniqueViolation(err)) {
    err.status = 409;
    err.message = "That already exists — refresh the page and try again.";
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({
    error: err.status ? err.message : "Something went wrong on our end."
  });
}

/** Wrap an async handler so a rejection becomes a clean response. */
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => sendError(res, err));
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }

/* ---- input checks ---------------------------------------------------------
   Every field a client sends is checked for type and length before it reaches
   the database. Without this, a number where text belongs crashes the route
   with a 500, and a blank name quietly saves. */

/** A text field: must be a non-empty string once trimmed, within `max`. */
function text(value, label, { max = 120, optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    fail(400, `${label} is required.`);
  }
  if (typeof value !== "string") fail(400, `${label} must be text.`);
  const v = value.trim();
  if (!v) {
    if (optional) return null;
    fail(400, `${label} is required.`);
  }
  if (v.length > max) fail(400, `${label} must be ${max} characters or fewer.`);
  return v;
}

function gradYear(value) {
  const year = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, "Enter a four-digit graduation year.");
  return year;
}

/** For PATCH routes: the new value if the field was sent, else the current one. */
const fieldOr = (body, key, current, check) =>
  Object.prototype.hasOwnProperty.call(body || {}, key) ? check(body[key]) : current;

/** A reviewing admin chosen from the list, or null. */
async function adminChoice(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !await get("SELECT 1 AS x FROM admins WHERE admin_id = ?", value)) {
    fail(400, "Pick a reviewing admin from the list.");
  }
  return value;
}

/** Load the profile row that belongs to an account. */
async function profileFor(user) {
  if (user.role === "student")  return get("SELECT * FROM students  WHERE student_id  = ?", user.student_id);
  if (user.role === "employer") return get("SELECT * FROM employers WHERE employer_id = ?", user.employer_id);
  return get("SELECT * FROM admins WHERE admin_id = ?", user.admin_id);
}

/** The signed-in student's coordinates, or null — the origin for distances. */
async function originFor(req) {
  if (req.user?.role !== "student") return null;
  const s = await get("SELECT latitude, longitude FROM students WHERE student_id = ?", req.user.student_id);
  return s && s.latitude != null ? s : null;
}

/** An explicit ?lat=&lon= beats the profile, so "use my location" works. */
async function requestOrigin(req) {
  const fromQuery = validCoords(req.query.lat, req.query.lon);
  return fromQuery || (await originFor(req));
}

/* ============================================================
   AUTH
   ============================================================ */

async function validateNewAccount(email, password) {
  const eProblem = emailProblem(email);
  if (eProblem) fail(400, eProblem);
  const pProblem = passwordProblem(password);
  if (pProblem) fail(400, pProblem);
  if (await get("SELECT 1 AS x FROM users WHERE lower(email) = lower(?)", email.trim())) {
    fail(409, "An account with that email already exists.");
  }
}

/**
 * Issue the session and set the cookie.
 *
 * The token goes ONLY into the httpOnly cookie — it is deliberately not in the
 * response body. A token the page's JavaScript can read is a token any
 * injected script can steal; the cookie is sent automatically and can't be
 * read by scripts at all.
 */
async function signInResponse(req, res, userRow, status = 200) {
  const user = publicUser(userRow);
  const { token, expires } = await startSession(user, req);
  res.cookie(COOKIE_NAME, token, cookieOptions(expires));
  res.status(status).json({ user, profile: await profileFor(user) });
}

app.post("/api/auth/signup/student", signupLimiter, h(async (req, res) => {
  const b = req.body || {};
  await validateNewAccount(b.email, b.password);
  const name = text(b.name, "Name");
  const school = text(b.school, "School");
  const location = text(b.location, "City and state");
  const year = gradYear(b.grad_year);

  // Coordinates the browser supplied win; otherwise geocode the typed town.
  // Either may end up null, and the app works without them.
  const point = validCoords(b.latitude, b.longitude) || await geocode(location);

  // Ids are picked by counting, so two signups at the same instant could pick
  // the same one — retryOnIdClash picks again if that happens.
  const user_id = await retryOnIdClash(async () => {
    const student_id = await nextId("students", "student_id", "st");
    const user_id = await nextId("users", "user_id", "us");
    // Profile row and account row are created together — a half-made account
    // with no profile would break every ownership check downstream.
    await tx(async t => {
      await t.run(
        "INSERT INTO students (student_id, name, school, grad_year, location, latitude, longitude) VALUES (?,?,?,?,?,?,?)",
        [student_id, name, school, year, location, point?.latitude ?? null, point?.longitude ?? null]
      );
      await t.run(
        "INSERT INTO users (user_id, email, password_hash, role, student_id) VALUES (?,?,?,'student',?)",
        [user_id, b.email.trim(), hashPassword(b.password), student_id]
      );
    });
    return user_id;
  });

  await signInResponse(req, res, await get("SELECT * FROM users WHERE user_id = ?", user_id), 201);
}));

app.post("/api/auth/signup/employer", signupLimiter, h(async (req, res) => {
  const b = req.body || {};
  await validateNewAccount(b.email, b.password);
  const company_name = text(b.company_name, "Company name");
  const industry = text(b.industry, "Industry");
  const location = text(b.location, "City and state");

  const point = validCoords(b.latitude, b.longitude) || await geocode(location);

  const user_id = await retryOnIdClash(async () => {
    const employer_id = await nextId("employers", "employer_id", "em");
    const user_id = await nextId("users", "user_id", "us");
    await tx(async t => {
      // New companies always start unverified; an admin grants verification.
      await t.run(
        "INSERT INTO employers (employer_id, company_name, industry, location, latitude, longitude, verified) VALUES (?,?,?,?,?,?,0)",
        [employer_id, company_name, industry, location, point?.latitude ?? null, point?.longitude ?? null]
      );
      await t.run(
        "INSERT INTO users (user_id, email, password_hash, role, employer_id) VALUES (?,?,?,'employer',?)",
        [user_id, b.email.trim(), hashPassword(b.password), employer_id]
      );
    });
    return user_id;
  });

  await signInResponse(req, res, await get("SELECT * FROM users WHERE user_id = ?", user_id), 201);
}));

app.post("/api/auth/login", loginNetworkLimiter, loginAccountLimiter, h(async (req, res) => {
  const { email, password } = req.body || {};
  const row = await get("SELECT * FROM users WHERE lower(email) = lower(?)", String(email || "").trim());
  // Same message either way — don't reveal which emails have accounts.
  if (!row || !checkPassword(String(password || ""), row.password_hash)) {
    fail(401, "That email and password don't match an account.");
  }
  await signInResponse(req, res, row);
}));

/** Who is signed in. A signed-out visitor gets nulls, not an error. */
app.get("/api/auth/me", h(async (req, res) => {
  if (!req.user) return res.json({ user: null, profile: null });
  res.json({ user: req.user, profile: await profileFor(req.user) });
}));

app.post("/api/auth/logout", h(async (req, res) => {
  if (req.sessionId) await revokeSession(req.sessionId);
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.json({ ok: true });
}));

/** Revoke every session for this account — "sign out everywhere". */
app.post("/api/auth/logout-all", requireAuth, h(async (req, res) => {
  const revoked = await revokeAllSessions(req.user.user_id);
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.json({ ok: true, revoked });
}));

app.get("/api/auth/sessions", requireAuth, h(async (req, res) => {
  const rows = await all(
    `SELECT session_id, created_at, expires_at, user_agent
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC`,
    req.user.user_id, nowStamp()
  );
  res.json(rows.map(r => ({ ...r, current: r.session_id === req.sessionId })));
}));

app.patch("/api/auth/password", requireAuth, passwordLimiter, h(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const row = await get("SELECT * FROM users WHERE user_id = ?", req.user.user_id);
  if (!checkPassword(String(current_password || ""), row.password_hash)) fail(403, "Current password is incorrect.");
  const problem = passwordProblem(new_password);
  if (problem) fail(400, problem);
  await run("UPDATE users SET password_hash = ? WHERE user_id = ?", hashPassword(new_password), req.user.user_id);
  // Changing a password ends every other session — that is the point of
  // changing it after a scare.
  await revokeAllSessions(req.user.user_id);
  await signInResponse(req, res, await get("SELECT * FROM users WHERE user_id = ?", req.user.user_id));
}));

/* ============================================================
   REFERENCE DATA (public)
   ============================================================ */

app.get("/api/programs", h(async (req, res) => {
  const { trade = "", search = "", sort = "cost" } = req.query;
  const ORDER = {
    cost: "cost ASC",
    wage: "avg_starting_wage DESC",
    // "best payback" — debt measured against what the job actually pays
    // NULLIF: a program reporting a $0 wage would otherwise divide by zero,
    // which Postgres treats as an error. NULLs sort last in both engines here.
    payback: "(CAST(avg_debt AS REAL) / NULLIF(avg_starting_wage, 0)) ASC",
    name: "provider_name ASC"
  };
  // `distance` is applied after the query, because neither engine has trig
  // functions available by default. See geo.js.
  const orderBy = ORDER[sort] || ORDER.cost;

  const rows = await all(
    `SELECT * FROM programs
      WHERE (? = '' OR trade = ?)
        AND (? = '' OR provider_name LIKE '%' || ? || '%'
                    OR location LIKE '%' || ? || '%'
                    OR trade LIKE '%' || ? || '%')
      ORDER BY ${orderBy}`,
    trade, trade, search, search, search, search
  );

  const origin = await requestOrigin(req);
  res.json(withDistance(rows, origin, { sort: sort === "distance" }));
}));

/** The distinct trades on offer, with each one's headline numbers. */
app.get("/api/trades", h(async (req, res) => res.json(
  await all(`SELECT trade,
                    COUNT(*)               AS program_count,
                    MIN(cost)              AS low_cost,
                    MAX(avg_starting_wage) AS top_wage
               FROM programs GROUP BY trade ORDER BY top_wage DESC`)
)));

/** Student job board — the `open_jobs` view decides what belongs here. */
app.get("/api/jobs", h(async (req, res) => {
  const { search = "", employer_id = "", source = "", sort = "" } = req.query;
  const rows = await all(
    `SELECT * FROM open_jobs
      WHERE (? = '' OR employer_id = ?)
        AND (? = '' OR source = ?)
        AND (? = '' OR title LIKE '%' || ? || '%' OR company_name LIKE '%' || ? || '%')
      ORDER BY company_name, title`,
    employer_id, employer_id, source, source, search, search, search
  );
  const origin = await requestOrigin(req);
  res.json(withDistance(rows, origin, { sort: sort === "distance" }));
}));

app.get("/api/admins", requireAuth, h(async (req, res) =>
  res.json(await all("SELECT * FROM admins ORDER BY name"))));

/** Everything the client needs to know about how this server is configured. */
app.get("/api/config", h(async (req, res) => res.json({
  ai_enabled: aiConfigured(),
  feeds_enabled: anyFeedConfigured(),
  database: DIALECT,
  // The sign-in page lists the demo accounts. On your own computer it can show
  // their password too; on a public site it never does — production requires
  // a private DEMO_PASSWORD, and printing it on the login page would undo that.
  demo_password: PRODUCTION ? null : DEMO_PASSWORD
})));

/* ============================================================
   STUDENTS
   ============================================================ */

app.get("/api/students", requireRole("admin"), h(async (req, res) => res.json(
  await all(
    `SELECT s.*, u.email,
            (SELECT COUNT(*) FROM applications a WHERE a.student_id = s.student_id) AS application_count,
            (SELECT COUNT(*) FROM quiz_results r WHERE r.student_id = s.student_id) AS quiz_count
       FROM students s LEFT JOIN users u ON u.student_id = s.student_id
      ORDER BY s.name`)
)));

app.patch("/api/students/:id", requireAuth, h(async (req, res) => {
  if (!ownsStudent(req, req.params.id)) fail(403, "You can only edit your own student profile.");
  const cur = await get("SELECT * FROM students WHERE student_id = ?", req.params.id);
  if (!cur) fail(404, "Student not found.");

  const b = req.body || {};
  const name      = fieldOr(b, "name",      cur.name,      v => text(v, "Name"));
  const school    = fieldOr(b, "school",    cur.school,    v => text(v, "School"));
  const grad_year = fieldOr(b, "grad_year", cur.grad_year, gradYear);
  const location  = fieldOr(b, "location",  cur.location,  v => text(v, "City and state"));

  // Re-geocode only when the town actually changed, or when the browser sent
  // fresh coordinates. No point calling a geocoder to rename someone.
  let point = validCoords(b.latitude, b.longitude);
  if (!point && location !== cur.location) point = await geocode(location);
  const lat = point ? point.latitude : cur.latitude;
  const lon = point ? point.longitude : cur.longitude;

  await run(
    "UPDATE students SET name=?, school=?, grad_year=?, location=?, latitude=?, longitude=? WHERE student_id=?",
    name, school, grad_year, location, lat, lon, req.params.id
  );
  res.json(await get("SELECT * FROM students WHERE student_id = ?", req.params.id));
}));

/** "Use my location" — store coordinates the browser gave us. */
app.put("/api/students/:id/location", requireAuth, h(async (req, res) => {
  if (!ownsStudent(req, req.params.id)) fail(403, "You can only set your own location.");
  const point = validCoords(req.body.latitude, req.body.longitude);
  if (!point) fail(400, "Send a valid latitude and longitude.");
  await run("UPDATE students SET latitude=?, longitude=? WHERE student_id=?",
            point.latitude, point.longitude, req.params.id);
  res.json(await get("SELECT * FROM students WHERE student_id = ?", req.params.id));
}));

/* ============================================================
   EMPLOYERS
   ============================================================ */

app.get("/api/employers", h(async (req, res) => res.json(
  await all(`SELECT e.*, (SELECT COUNT(*) FROM job_postings j WHERE j.employer_id = e.employer_id) AS posting_count
               FROM employers e ORDER BY e.company_name`)
)));

app.patch("/api/employers/:id", requireRole("employer", "admin"), h(async (req, res) => {
  if (!ownsEmployer(req, req.params.id)) fail(403, "You can only edit your own company profile.");
  const cur = await get("SELECT * FROM employers WHERE employer_id = ?", req.params.id);
  if (!cur) fail(404, "Employer not found.");
  // `verified` is deliberately NOT settable here — only an admin can grant it.
  const b = req.body || {};
  const company_name = fieldOr(b, "company_name", cur.company_name, v => text(v, "Company name"));
  const industry     = fieldOr(b, "industry",     cur.industry,     v => text(v, "Industry"));
  const location     = fieldOr(b, "location",     cur.location,     v => text(v, "City and state"));

  let point = null;
  if (location !== cur.location) point = await geocode(location);

  await run(
    "UPDATE employers SET company_name=?, industry=?, location=?, latitude=?, longitude=? WHERE employer_id=?",
    company_name, industry, location,
    point ? point.latitude : cur.latitude,
    point ? point.longitude : cur.longitude,
    req.params.id
  );
  res.json(await get("SELECT * FROM employers WHERE employer_id = ?", req.params.id));
}));

/** Admin-only: grant or revoke verification. */
app.patch("/api/employers/:id/verification", requireRole("admin"), h(async (req, res) => {
  if (!await get("SELECT 1 AS x FROM employers WHERE employer_id = ?", req.params.id)) fail(404, "Employer not found.");
  if (typeof req.body.verified !== "boolean") fail(400, "Body must include verified: true or false.");
  await run("UPDATE employers SET verified=? WHERE employer_id=?", req.body.verified ? 1 : 0, req.params.id);
  res.json(await get("SELECT * FROM employers WHERE employer_id = ?", req.params.id));
}));

/* ============================================================
   JOB POSTINGS
   ============================================================ */

/** Employer/admin view — every posting regardless of status. */
app.get("/api/postings", requireRole("employer", "admin"), h(async (req, res) => {
  let { employer_id = "", status = "", source = "" } = req.query;
  if (req.user.role === "employer") employer_id = req.user.employer_id; // never leak another company's drafts
  res.json(await all(
    `SELECT j.*, COALESCE(e.company_name, j.company_name) AS company_name, e.verified, a.name AS admin_name,
            (SELECT COUNT(*) FROM applications ap WHERE ap.job_id = j.job_id) AS applicant_count
       FROM job_postings j
       LEFT JOIN employers e ON e.employer_id = j.employer_id
       LEFT JOIN admins a ON a.admin_id = j.admin_id
      WHERE (? = '' OR j.employer_id = ?) AND (? = '' OR j.status = ?) AND (? = '' OR j.source = ?)
      ORDER BY j.job_id`,
    employer_id, employer_id, status, status, source, source
  ));
}));

app.post("/api/postings", requireRole("employer"), h(async (req, res) => {
  const b = req.body || {};
  const title = text(b.title, "Job title");
  const wage_range = text(b.wage_range, "Wage range", { max: 60 });
  const admin_id = await adminChoice(b.admin_id);
  const employer_id = req.user.employer_id; // taken from the session, never the body
  // New postings always start in review — an employer cannot publish directly.
  const job_id = await retryOnIdClash(async () => {
    const job_id = await nextId("job_postings", "job_id", "jb");
    await run(
      `INSERT INTO job_postings (job_id, source, employer_id, admin_id, title, wage_range, status)
       VALUES (?, 'employer', ?, ?, ?, ?, 'pending')`,
      job_id, employer_id, admin_id, title, wage_range
    );
    return job_id;
  });
  res.status(201).json(await get("SELECT * FROM job_postings WHERE job_id = ?", job_id));
}));

app.patch("/api/postings/:id", requireRole("employer", "admin"), h(async (req, res) => {
  const cur = await get("SELECT * FROM job_postings WHERE job_id = ?", req.params.id);
  if (!cur) fail(404, "Posting not found.");
  if (cur.source !== "employer") fail(400, "Imported postings are owned by their source feed and can't be edited here.");
  if (!ownsEmployer(req, cur.employer_id)) fail(403, "That posting belongs to another company.");
  const b = req.body || {};
  const title      = fieldOr(b, "title",      cur.title,      v => text(v, "Job title"));
  const wage_range = fieldOr(b, "wage_range", cur.wage_range, v => text(v, "Wage range", { max: 60 }));
  const admin_id   = Object.prototype.hasOwnProperty.call(b, "admin_id") ? await adminChoice(b.admin_id) : cur.admin_id;
  // Any edit sends the posting back through review.
  await run("UPDATE job_postings SET title=?, wage_range=?, admin_id=?, status='pending' WHERE job_id=?",
            title, wage_range, admin_id, req.params.id);
  res.json(await get("SELECT * FROM job_postings WHERE job_id = ?", req.params.id));
}));

/** Admin decision. Stamps the deciding admin onto the row. */
app.patch("/api/postings/:id/moderation", requireRole("admin"), h(async (req, res) => {
  const { decision } = req.body;
  if (!["approved", "rejected"].includes(decision)) fail(400, "Decision must be 'approved' or 'rejected'.");
  const cur = await get("SELECT * FROM job_postings WHERE job_id = ?", req.params.id);
  if (!cur) fail(404, "Posting not found.");
  if (cur.source !== "employer") fail(400, "Imported postings don't go through review.");
  await run("UPDATE job_postings SET status=?, admin_id=? WHERE job_id=?", decision, req.user.admin_id, req.params.id);
  res.json(await get("SELECT * FROM job_postings WHERE job_id = ?", req.params.id));
}));

app.delete("/api/postings/:id", requireRole("employer", "admin"), h(async (req, res) => {
  const cur = await get("SELECT * FROM job_postings WHERE job_id = ?", req.params.id);
  if (!cur) fail(404, "Posting not found.");
  if (cur.source === "employer" && !ownsEmployer(req, cur.employer_id)) {
    fail(403, "That posting belongs to another company.");
  }
  if (cur.source !== "employer" && req.user.role !== "admin") {
    fail(403, "Only an admin can remove an imported posting.");
  }
  await run("DELETE FROM job_postings WHERE job_id = ?", req.params.id); // applications cascade
  res.status(204).end();
}));

/* ============================================================
   JOB FEEDS (admin)
   ============================================================ */

app.get("/api/feeds", requireRole("admin"), h(async (req, res) => res.json(await feedStatus())));

app.post("/api/feeds/sync", requireRole("admin"), syncLimiter, h(async (req, res) => {
  const b = req.body || {};
  const where = text(b.where, "Area", { optional: true }) || undefined;
  const radius = b.radius_miles === undefined || b.radius_miles === "" ? undefined : Number(b.radius_miles);
  if (radius !== undefined && !(Number.isFinite(radius) && radius >= 5 && radius <= 200)) {
    fail(400, "Radius must be between 5 and 200 miles.");
  }
  const result = await syncJobs({ where, radiusMiles: radius });
  res.json(result);
}));

/* ============================================================
   APPLICATIONS
   ============================================================ */

app.get("/api/applications", requireAuth, h(async (req, res) => {
  // Scope comes from the token, not the query string.
  let student_id = "", employer_id = "";
  if (req.user.role === "student")  student_id  = req.user.student_id;
  if (req.user.role === "employer") employer_id = req.user.employer_id;
  res.json(await all(
    `SELECT ap.*, j.title, j.wage_range, j.employer_id, j.source,
            COALESCE(e.company_name, j.company_name) AS company_name,
            s.name AS student_name, s.school, s.grad_year, s.location
       FROM applications ap
       JOIN job_postings j ON j.job_id = ap.job_id
       LEFT JOIN employers e ON e.employer_id = j.employer_id
       JOIN students s ON s.student_id = ap.student_id
      WHERE (? = '' OR ap.student_id = ?) AND (? = '' OR j.employer_id = ?)
      ORDER BY ap.applied_date DESC`,
    student_id, student_id, employer_id, employer_id
  ));
}));

app.post("/api/applications", requireRole("student"), h(async (req, res) => {
  const student_id = req.user.student_id;
  const job_id = text((req.body || {}).job_id, "Posting", { max: 40 });

  const job = await get("SELECT * FROM open_jobs WHERE job_id = ?", job_id);
  if (!job) fail(400, "That posting is not open for applications.");

  // The rule that keeps applications from vanishing: an imported job has no
  // employer account on this platform, so there is nobody here to receive it.
  if (job.source !== "employer") {
    fail(400, "This listing came from an outside job board — apply on the employer's own site.");
  }

  if (await get("SELECT 1 AS x FROM applications WHERE student_id = ? AND job_id = ?", student_id, job_id)) {
    fail(409, "You've already applied to this posting.");
  }

  const application_id = await retryOnIdClash(async () => {
    const application_id = await nextId("applications", "application_id", "ap");
    await run(
      "INSERT INTO applications (application_id, student_id, job_id, status, applied_date) VALUES (?,?,?,'submitted',?)",
      application_id, student_id, job_id, nowStamp()
    );
    return application_id;
  });
  res.status(201).json(await get("SELECT * FROM applications WHERE application_id = ?", application_id));
}));

app.patch("/api/applications/:id", requireAuth, h(async (req, res) => {
  const cur = await get(
    `SELECT ap.*, j.employer_id FROM applications ap
       JOIN job_postings j ON j.job_id = ap.job_id WHERE ap.application_id = ?`, req.params.id);
  if (!cur) fail(404, "Application not found.");
  const status = (req.body || {}).status;

  if (req.user.role === "student") {
    if (cur.student_id !== req.user.student_id) fail(403, "That application isn't yours.");
    if (status !== "withdrawn") fail(403, "Students can only withdraw an application.");
    if (cur.status === "withdrawn") fail(409, "You've already withdrawn this application.");
    if (cur.status === "rejected") fail(409, "This application was already turned down, so there's nothing to withdraw.");
  } else if (req.user.role === "employer") {
    if (!ownsEmployer(req, cur.employer_id)) fail(403, "That application is for another company's posting.");
    // A withdrawal is the student's decision. The hiring screen hides the
    // control, but the rule has to live here — the screen is not a security
    // boundary, and anyone can send this request without it.
    if (cur.status === "withdrawn") fail(409, "The student withdrew this application, so its status can't be changed.");
    if (!["submitted", "reviewing", "interview", "offer", "rejected"].includes(status)) {
      fail(400, "Pick a valid hiring stage.");
    }
  } else {
    fail(403, "Admins don't change application status.");
  }

  await run("UPDATE applications SET status=? WHERE application_id=?", status, req.params.id);
  res.json(await get("SELECT * FROM applications WHERE application_id = ?", req.params.id));
}));

/* ============================================================
   QUIZ
   ============================================================ */

app.get("/api/quiz", h(async (req, res) => res.json({ questions: QUIZ })));

app.get("/api/quiz/me", requireRole("student"), h(async (req, res) => {
  const row = await get("SELECT * FROM quiz_results WHERE student_id = ? ORDER BY quiz_id DESC LIMIT 1", req.user.student_id);
  if (!row) return res.json(null);
  const answers = JSON.parse(row.answers);
  res.json({ ...row, answers, matches: scoreTrades(answers, await all("SELECT * FROM programs")) });
}));

app.post("/api/quiz", requireRole("student"), h(async (req, res) => {
  const student_id = req.user.student_id;
  const { answers } = req.body;
  if (!validAnswers(answers)) fail(400, `Answer all ${QUIZ.length} questions.`);
  const existing = await get("SELECT quiz_id FROM quiz_results WHERE student_id = ? ORDER BY quiz_id DESC LIMIT 1", student_id);
  let quiz_id = existing?.quiz_id;
  if (existing) {
    await run("UPDATE quiz_results SET answers = ? WHERE quiz_id = ?", JSON.stringify(answers), quiz_id);
  } else {
    quiz_id = await retryOnIdClash(async () => {
      const id = await nextId("quiz_results", "quiz_id", "qz");
      await run("INSERT INTO quiz_results (quiz_id, student_id, answers) VALUES (?,?,?)", id, student_id, JSON.stringify(answers));
      return id;
    });
  }
  res.json({ quiz_id, student_id, answers, matches: scoreTrades(answers, await all("SELECT * FROM programs")) });
}));

/* ============================================================
   RESUMES
   ============================================================ */

/* Files are held in memory, never written to disk: we extract the text,
   store that, and drop the buffer. 5 MB is generous for a resume. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

/** Everything the matcher is allowed to recommend from. */
async function matchContext(studentId) {
  const student = await get("SELECT * FROM students WHERE student_id = ?", studentId);
  const quiz = await get("SELECT answers FROM quiz_results WHERE student_id = ? ORDER BY quiz_id DESC LIMIT 1", studentId);
  const programRows = await all("SELECT * FROM programs");

  let quizTopMatches = [];
  if (quiz) quizTopMatches = scoreTrades(JSON.parse(quiz.answers), programRows).slice(0, 3).map(t => t.trade);

  // Distance is part of the recommendation, so the matcher can prefer a
  // provider 12 miles away over an equivalent one 200 miles away.
  const distanceOf = row =>
    student?.latitude == null ? null
      : milesBetween(student.latitude, student.longitude, row.latitude, row.longitude);

  const jobRows = await all("SELECT * FROM open_jobs");

  return {
    student,
    quizTopMatches,
    programs: programRows.map(p => ({
      program_id: p.program_id, trade: p.trade, provider: p.provider_name,
      location: p.location, cost: p.cost, time_to_certify: p.time_to_certify,
      avg_starting_wage: p.avg_starting_wage, avg_debt: p.avg_debt,
      miles_from_student: distanceOf(p)
    })),
    jobs: jobRows.map(j => ({
      job_id: j.job_id, title: j.title, company: j.company_name,
      industry: j.industry, location: j.location, wage_range: j.wage_range,
      miles_from_student: distanceOf(j)
    }))
  };
}

/** Expand stored ids back into full rows so the client renders one payload. */
async function hydrate(analysis) {
  if (!analysis) return null;
  const programs = [];
  for (const m of analysis.program_recommendations) {
    const program = await get("SELECT * FROM programs WHERE program_id = ?", m.program_id);
    if (program) programs.push({ ...m, program });
  }
  const jobs = [];
  for (const m of analysis.job_recommendations) {
    const job = await get("SELECT * FROM open_jobs WHERE job_id = ?", m.job_id);
    if (job) jobs.push({ ...m, job });
  }
  return { ...analysis, program_recommendations: programs, job_recommendations: jobs };
}

async function resumeResponse(row) {
  if (!row) return null;
  const { content, analysis, ...rest } = row;
  return { ...rest, excerpt: content.slice(0, 400), analysis: await hydrate(analysis ? JSON.parse(analysis) : null) };
}

app.get("/api/resumes/me", requireRole("student"), h(async (req, res) => {
  res.json(await resumeResponse(await get("SELECT * FROM resumes WHERE student_id = ?", req.user.student_id)));
}));

/** Upload a file OR post `{ text }` — both land in the same row. */
app.post("/api/resumes", requireRole("student"), uploadLimiter, upload.single("resume"), h(async (req, res) => {
  const studentId = req.user.student_id;
  let resumeText = "";
  let filename = "pasted text";

  if (req.file) {
    filename = req.file.originalname || "resume";
    resumeText = await extractText(req.file.buffer, filename, req.file.mimetype || "");
  } else if (typeof req.body?.text === "string") {
    resumeText = req.body.text;
  } else {
    fail(400, "Attach a file or send text.");
  }

  resumeText = resumeText.replace(/[ \t]+\n/g, "\n").trim();
  if (resumeText.length < 40) fail(400, "That came out nearly empty — paste a few lines about your classes, jobs and tools.");
  resumeText = resumeText.slice(0, MAX_RESUME_CHARS);

  // One current resume per student: replacing it drops the old analysis too,
  // so stale recommendations can never outlive the resume they came from.
  const resume_id = await retryOnIdClash(async () => {
    const id = await nextId("resumes", "resume_id", "rs");
    await tx(async t => {
      await t.run("DELETE FROM resumes WHERE student_id = ?", [studentId]);
      await t.run(
        "INSERT INTO resumes (resume_id, student_id, filename, uploaded_at, char_count, content) VALUES (?,?,?,?,?,?)",
        [id, studentId, filename.slice(0, 200), nowStamp(), resumeText.length, resumeText]
      );
    });
    return id;
  });

  res.status(201).json(await resumeResponse(await get("SELECT * FROM resumes WHERE resume_id = ?", resume_id)));
}));

app.post("/api/resumes/me/analysis", requireRole("student"), scanLimiter, h(async (req, res) => {
  const row = await get("SELECT * FROM resumes WHERE student_id = ?", req.user.student_id);
  if (!row) fail(404, "Upload a resume first.");

  const { engine, model, analysis } = await analyzeResume(row.content, await matchContext(req.user.student_id));
  await run("UPDATE resumes SET analysis=?, engine=?, model=?, analyzed_at=? WHERE resume_id=?",
            JSON.stringify(analysis), engine, model, nowStamp(), row.resume_id);

  res.json(await resumeResponse(await get("SELECT * FROM resumes WHERE resume_id = ?", row.resume_id)));
}));

app.delete("/api/resumes/me", requireRole("student"), h(async (req, res) => {
  await run("DELETE FROM resumes WHERE student_id = ?", req.user.student_id);
  res.status(204).end();
}));

/* ============================================================
   STATS (admin dashboard)
   ============================================================ */

const count = async sql => Number((await get(sql)).n);

app.get("/api/stats", requireRole("admin"), h(async (req, res) => res.json({
  students:        await count("SELECT COUNT(*) AS n FROM students"),
  quizzes:         await count("SELECT COUNT(*) AS n FROM quiz_results"),
  employers:       await count("SELECT COUNT(*) AS n FROM employers"),
  unverified:      await count("SELECT COUNT(*) AS n FROM employers WHERE verified = 0"),
  pending_reviews: await count("SELECT COUNT(*) AS n FROM job_postings WHERE status = 'pending' AND source = 'employer'"),
  open_jobs:       await count("SELECT COUNT(*) AS n FROM open_jobs"),
  imported_jobs:   await count("SELECT COUNT(*) AS n FROM job_postings WHERE source <> 'employer'"),
  applications:    await count("SELECT COUNT(*) AS n FROM applications"),
  programs:        await count("SELECT COUNT(*) AS n FROM programs"),
  resumes:         await count("SELECT COUNT(*) AS n FROM resumes"),
  resumes_scanned: await count("SELECT COUNT(*) AS n FROM resumes WHERE analysis IS NOT NULL")
})));

/* ============================================================
   HEALTH, 404, AND THE WEB APP
   ============================================================ */

app.get("/api/health", (req, res) => res.json({
  ok: true, database: DIALECT, ai_enabled: aiConfigured(), feeds_enabled: anyFeedConfigured()
}));

// Any /api/* path that reached here is a real 404 — answer in JSON before the
// SPA fallback below can swallow it and return index.html instead.
app.use("/api", (req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));

/* Serving the built client from this same process means one URL, one deploy,
   and no CORS. `npm run build` at the repo root produces client/dist; if it is
   missing we say so rather than 404-ing mysteriously. */
const CLIENT_DIST = path.join(here, "..", "client", "dist");

if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
  // Hashed asset filenames can be cached hard; index.html must not be, or
  // browsers keep loading the old build after a deploy.
  app.use(express.static(CLIENT_DIST, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
      else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  }));

  // The client routes in memory, so every non-API path serves index.html and
  // lets React decide. Without this, a refresh on any deep link 404s.
  app.get("*", (req, res) =>
    res.sendFile(path.join(CLIENT_DIST, "index.html"), { headers: { "Cache-Control": "no-cache" } }));
} else {
  app.get("*", (req, res) => res.status(503).json({
    error: "The web app has not been built. Run `npm run build` at the repo root, or use the Vite dev server on :5173."
  }));
}

/* Express hands multer's own failures (file too large, too many files) here
   rather than to a route, so they need their own translation to JSON. */
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "That file is over 5 MB. Export a smaller copy." });
  }
  if (err && err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: "Send the file in a field named 'resume'." });
  }
  sendError(res, err || new Error("Unknown error"));
});

app.listen(PORT, () => {
  console.log(`Anvil listening on http://localhost:${PORT}`);
  console.log(`  mode:        ${PRODUCTION ? "production" : "development"}`);
  console.log(`  database:    ${describe()}`);
  console.log(`  resume scan: ${aiConfigured() ? "AI (Anthropic)" : "offline keyword matcher"}`);
  console.log(`  job feeds:   ${anyFeedConfigured() ? "configured" : "none — employer postings only"}`);
});
