/**
 * End-to-end API tests. Each run seeds a fresh database, starts the real
 * server on a spare port, and talks to it over HTTP like the browser does.
 *
 *   cd server && npm test                         # SQLite (a temp file)
 *   DATABASE_URL=postgres://... npm test          # the same tests on Postgres
 *
 * Needs Node 20+ (built-in test runner and fetch).
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-test-"));
const PW = "anvil1234";
const DEMO = {
  student: "jordan.ellis@student.test",
  student2: "maya.whitfield@student.test",
  employer: "hiring@carolinacurrentelectric.test",      // em-01, owns jb-01..03
  employer2: "hiring@piedmontmechanical.test",          // em-02, owns jb-04..06
  admin: "renee.alvarado@anvil.test"
};

let nextPort = 41000 + Math.floor(Math.random() * 2000);

/* ---------- a server per test group ---------- */

function baseEnv(extra = {}) {
  const env = { ...process.env, NODE_ENV: "development", ANTHROPIC_API_KEY: "", ADZUNA_APP_ID: "",
                ADZUNA_APP_KEY: "", COS_USER_ID: "", COS_TOKEN: "", DEMO_PASSWORD: "", ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

async function startServer(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, ["index.js"], {
    cwd: SERVER_DIR, env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", d => (output += d));
  child.stderr.on("data", d => (output += d));
  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try { if ((await fetch(base + "/health")).ok) return { base, child, output: () => output }; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start:\n${output}`);
}

/** Run the server to completion and capture how it exited (for boot refusals). */
function bootOnce(env) {
  const r = spawnSync(process.execPath, ["index.js"], {
    cwd: SERVER_DIR, env: { ...env, PORT: String(nextPort++) }, encoding: "utf8", timeout: 15000
  });
  return { code: r.status, output: (r.stdout || "") + (r.stderr || "") };
}

/** A tiny browser: keeps the session cookie between requests, like a tab does. */
function client(base) {
  let cookie = "";
  async function call(method, route, body) {
    const res = await fetch(base + route, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(";");
      cookie = pair.endsWith("=") ? "" : pair;
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, setCookie: set };
  }
  return {
    get: r => call("GET", r),
    post: (r, b = {}) => call("POST", r, b),
    patch: (r, b = {}) => call("PATCH", r, b),
    put: (r, b = {}) => call("PUT", r, b),
    del: r => call("DELETE", r),
    login: (email, password = PW) => call("POST", "/auth/login", { email, password }),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; }
  };
}

async function as(base, email, password = PW) {
  const c = client(base);
  const r = await c.login(email, password);
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return c;
}

/* ============================================================
   THE MAIN SUITE — development mode, freshly seeded
   ============================================================ */

describe("API", () => {
  let srv, base;

  before(async () => {
    const env = baseEnv({ DATABASE_PATH: path.join(TMP, "main.db") });
    const seeded = spawnSync(process.execPath, ["seed.js"], { cwd: SERVER_DIR, env, encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    srv = await startServer(env);
    base = srv.base;
  });
  after(() => srv?.child.kill());

  describe("auth", () => {
    test("login sets an httpOnly cookie and never returns the token", async () => {
      const c = client(base);
      const r = await c.login(DEMO.student);
      assert.equal(r.status, 200);
      assert.equal(r.data.token, undefined);
      assert.equal(r.data.user.password_hash, undefined);
      assert.match(r.setCookie.join(";"), /HttpOnly/i);
      assert.match(r.setCookie.join(";"), /SameSite=Lax/i);
    });

    test("wrong password and unknown email get the same 401", async () => {
      const a = await client(base).login(DEMO.student, "wrong-pass-1");
      const b = await client(base).login("nobody@nowhere.test", "wrong-pass-1");
      assert.equal(a.status, 401);
      assert.deepEqual(a.data, b.data);
    });

    test("/auth/me answers from the cookie, and says nobody when signed out", async () => {
      const c = await as(base, DEMO.student);
      assert.equal((await c.get("/auth/me")).data.user.email, DEMO.student);
      assert.deepEqual((await client(base).get("/auth/me")).data, { user: null, profile: null });
    });

    test("a Bearer header is no longer accepted", async () => {
      const c = await as(base, DEMO.student);
      const token = c.cookie.split("=")[1];
      const res = await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${token}` } });
      assert.equal((await res.json()).user, null);
    });

    test("signing out revokes the session, not just the cookie", async () => {
      const c = await as(base, DEMO.student);
      const stolen = c.cookie;
      await c.post("/auth/logout");
      const thief = client(base); thief.cookie = stolen;
      assert.equal((await thief.get("/auth/me")).data.user, null);
    });

    test("sign out everywhere revokes every device", async () => {
      const a = await as(base, DEMO.student);
      const b = await as(base, DEMO.student);
      assert.equal((await a.post("/auth/logout-all")).status, 200);
      assert.equal((await b.get("/auth/me")).data.user, null);
    });

    test("sessions list marks the current one", async () => {
      const c = await as(base, DEMO.student);
      const r = await c.get("/auth/sessions");
      assert.equal(r.data.filter(s => s.current).length, 1);
    });
  });

  describe("rate limits count per account, not per network", () => {
    test("a classroom can sign in together — correct passwords never count", async () => {
      for (let i = 0; i < 40; i++) assert.equal((await client(base).login(DEMO.student2)).status, 200);
    });

    test("10 wrong passwords lock that one email, not everyone", async () => {
      const target = "sofia.delgado@student.test";   // not used by any other test
      for (let i = 0; i < 10; i++) assert.equal((await client(base).login(target, "guess-" + i + "x")).status, 401);
      assert.equal((await client(base).login(target, "guess-11x")).status, 429);
      assert.equal((await client(base).login(DEMO.admin)).status, 200);
    });
  });

  describe("demo password on the login page", () => {
    test("shown on your own computer", async () => {
      assert.equal((await client(base).get("/config")).data.demo_password, PW);
    });
  });

  describe("input checks", () => {
    test("signup rejects non-text fields with a 400, not a crash", async () => {
      const r = await client(base).post("/auth/signup/student", {
        email: `n${Date.now()}@t.test`, password: "hammer99", name: 42, school: "HS", grad_year: 2027, location: "Apex, NC"
      });
      assert.equal(r.status, 400);
    });

    test("profile edits reject a blank name and a non-numeric year", async () => {
      const c = await as(base, DEMO.student);
      assert.equal((await c.patch("/students/st-01", { name: "   " })).status, 400);
      assert.equal((await c.patch("/students/st-01", { grad_year: "abc" })).status, 400);
      assert.equal((await c.patch("/students/st-01", { grad_year: 2031 })).status, 200);
      assert.equal((await c.patch("/students/st-01", { grad_year: 2027 })).data.grad_year, 2027);
    });

    test("postings reject a number title, an overlong title and an unknown admin", async () => {
      const e = await as(base, DEMO.employer);
      assert.equal((await e.post("/postings", { title: 5, wage_range: "$20/hr" })).status, 400);
      assert.equal((await e.post("/postings", { title: "x".repeat(200), wage_range: "$20/hr" })).status, 400);
      assert.equal((await e.post("/postings", { title: "Helper", wage_range: "$20/hr", admin_id: "ad-99" })).status, 400);
      const ok = await e.post("/postings", { title: "Shop Helper", wage_range: "$18-$21/hr", admin_id: "ad-01" });
      assert.equal(ok.status, 201);
      assert.equal(ok.data.status, "pending");
    });

    test("empty coordinates are rejected instead of becoming 0,0", async () => {
      const c = await as(base, DEMO.student);
      assert.equal((await c.put("/students/st-01/location", { latitude: null, longitude: null })).status, 400);
      assert.equal((await c.put("/students/st-01/location", { latitude: "", longitude: "" })).status, 400);
      assert.equal((await c.put("/students/st-01/location", { latitude: 999, longitude: 0 })).status, 400);
    });
  });

  describe("who may change what", () => {
    test("admins read the roster but can't edit a student", async () => {
      const a = await as(base, DEMO.admin);
      assert.equal((await a.get("/students")).status, 200);
      assert.equal((await a.patch("/students/st-02", { name: "Edited" })).status, 403);
      assert.equal((await a.put("/students/st-02/location", { latitude: 35, longitude: -78 })).status, 403);
    });

    test("a student can't set another student's location", async () => {
      const c = await as(base, DEMO.student);
      assert.equal((await c.put("/students/st-02/location", { latitude: 35, longitude: -78 })).status, 403);
    });

    test("a student can't read admin stats", async () => {
      assert.equal((await (await as(base, DEMO.student)).get("/stats")).status, 403);
    });

    test("employers only see their own postings", async () => {
      const r = await (await as(base, DEMO.employer)).get("/postings");
      assert.deepEqual([...new Set(r.data.map(j => j.employer_id))], ["em-01"]);
    });
  });

  describe("applications", () => {
    test("apply, duplicate, and a posting that isn't open", async () => {
      const s = await as(base, DEMO.student);
      assert.equal((await s.post("/applications", { job_id: "jb-02" })).status, 201);
      assert.equal((await s.post("/applications", { job_id: "jb-02" })).status, 409);
      assert.equal((await s.post("/applications", { job_id: "jb-08" })).status, 400);
      assert.equal((await s.post("/applications", { job_id: 7 })).status, 400);
    });

    test("once a student withdraws, the employer can't move it back", async () => {
      const s = await as(base, DEMO.student);
      const mine = (await s.get("/applications")).data.find(a => a.job_id === "jb-04");
      assert.equal((await s.patch(`/applications/${mine.application_id}`, { status: "withdrawn" })).status, 200);
      assert.equal((await s.patch(`/applications/${mine.application_id}`, { status: "withdrawn" })).status, 409);
      const e = await as(base, DEMO.employer2);
      const r = await e.patch(`/applications/${mine.application_id}`, { status: "interview" });
      assert.equal(r.status, 409);
      assert.match(r.data.error, /withdrew/);
    });

    test("employers can't touch another company's applicants", async () => {
      const e = await as(base, DEMO.employer);
      assert.equal((await e.patch("/applications/ap-03", { status: "offer" })).status, 403);
    });
  });

  describe("geolocation", () => {
    test("signed-in students get distances, sorted nearest first", async () => {
      const s = await as(base, DEMO.student2);
      const rows = (await s.get("/programs?sort=distance")).data;
      const d = rows.map(r => r.distance_miles).filter(x => x != null);
      assert.ok(d.length > 5);
      assert.deepEqual(d, [...d].sort((a, b) => a - b));
    });

    test("?lat=&lon= overrides the profile; anonymous visitors get no distance", async () => {
      const s = await as(base, DEMO.student2);
      const r = await s.get("/programs?sort=distance&lat=34.2257&lon=-77.9447");
      assert.equal(r.data[0].location, "Wilmington, NC");
      assert.equal((await client(base).get("/programs")).data[0].distance_miles, null);
    });

    test("signup keeps coordinates the browser supplied", async () => {
      const r = await client(base).post("/auth/signup/student", {
        email: `geo${Date.now()}@t.test`, password: "hammer99", name: "Geo Kid", school: "HS",
        grad_year: 2027, location: "Nowhere", latitude: 35.5, longitude: -78.5
      });
      assert.equal(r.status, 201);
      assert.equal(r.data.profile.latitude, 35.5);
    });
  });

  describe("resume scan (offline matcher)", () => {
    test("an ordinary resume with no trade words is not called a strong match", async () => {
      const s = await as(base, DEMO.student2);
      await s.post("/resumes", { text: "Career goal: start a career. Cashier at a grocery store. Academic honors. Built a database for the library club. I like to investigate how things work." });
      const a = (await s.post("/resumes/me/analysis")).data.analysis;
      assert.deepEqual(a.skills, []);
      assert.equal(a.job_recommendations.length, 0);
      assert.ok(a.program_recommendations.every(p => p.fit <= 30));
      assert.match(a.summary, /Nothing in the resume matched/);
    });

    test("a welding resume points at welding programs and welding jobs", async () => {
      const s = await as(base, DEMO.student);
      assert.equal((await s.post("/resumes", { text: "CTE Welding I and II, OSHA 10, MIG and TIG welding, plasma cutting, blueprint reading, calipers." })).status, 201);
      const a = (await s.post("/resumes/me/analysis")).data.analysis;
      assert.equal(a.program_recommendations[0].program.trade, "Welding & Fabrication");
      assert.ok(a.job_recommendations.some(j => /Welder/.test(j.job.title)));
      assert.ok(a.skills.includes("welding"));
    });

    test("scan limits are per student", async () => {
      const s = await as(base, DEMO.student);
      let last;
      for (let i = 0; i < 21; i++) last = await s.post("/resumes/me/analysis");
      assert.equal(last.status, 429);
      const other = await as(base, DEMO.student2);
      assert.equal((await other.post("/resumes/me/analysis")).status, 200);
    });
  });

  describe("quiz", () => {
    test("scores on the server", async () => {
      const s = await as(base, DEMO.student);
      const r = await s.post("/quiz", { answers: [1, 1, 2, 0, 2, 1] });
      assert.equal(r.data.matches[0].trade, "Welding & Fabrication");
      assert.equal((await s.post("/quiz", { answers: [9, 9, 9, 9, 9, 9] })).status, 400);
    });
  });

  describe("feeds", () => {
    test("admin-only, and says when nothing is configured", async () => {
      assert.equal((await (await as(base, DEMO.student)).get("/feeds")).status, 403);
      const a = await as(base, DEMO.admin);
      assert.equal((await a.post("/feeds/sync")).data.ran, false);
    });
  });

  describe("ids under concurrency", () => {
    test("twelve signups at once all succeed with distinct ids", async () => {
      const stamp = Date.now();
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        client(base).post("/auth/signup/employer", {
          email: `race${stamp}-${i}@t.test`, password: "hammer99",
          company_name: `Race Co ${i}`, industry: "Testing", location: "Raleigh, NC"
        })));
      assert.deepEqual(results.map(r => r.status), Array(12).fill(201));
      assert.equal(new Set(results.map(r => r.data.profile.employer_id)).size, 12);
    });
  });
});

/* ============================================================
   PRODUCTION BOOT RULES — always on SQLite temp files
   ============================================================ */

describe("production", () => {
  const prodEnv = extra => baseEnv({
    DATABASE_URL: undefined, NODE_ENV: "production", JWT_SECRET: "t".repeat(64), ...extra
  });

  test("refuses to start without DEMO_PASSWORD", () => {
    const r = bootOnce(prodEnv({ DATABASE_PATH: path.join(TMP, "p1.db") }));
    assert.equal(r.code, 1);
    assert.match(r.output, /DEMO_PASSWORD is not set/);
  });

  test("refuses to start with the published password", () => {
    const r = bootOnce(prodEnv({ DATABASE_PATH: path.join(TMP, "p2.db"), DEMO_PASSWORD: PW }));
    assert.equal(r.code, 1);
    assert.match(r.output, /public default/);
  });

  test("refuses to start without JWT_SECRET", () => {
    const r = bootOnce(prodEnv({ DATABASE_PATH: path.join(TMP, "p3.db"), DEMO_PASSWORD: "Private123", JWT_SECRET: "" }));
    assert.equal(r.code, 1);
    assert.match(r.output, /JWT_SECRET is not set/);
  });

  test("an old deployment's demo accounts move off the published password", async () => {
    const db = path.join(TMP, "p4.db");
    // Seeded the old way — every demo account on anvil1234.
    const seeded = spawnSync(process.execPath, ["seed.js"], { cwd: SERVER_DIR, env: baseEnv({ DATABASE_URL: undefined, DATABASE_PATH: db }), encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);

    const srv = await startServer(prodEnv({ DATABASE_PATH: db, DEMO_PASSWORD: "Private123" }));
    try {
      assert.match(srv.output(), /Moved 14 demo account/);
      assert.equal((await client(srv.base).login(DEMO.admin, PW)).status, 401);
      assert.equal((await client(srv.base).login(DEMO.admin, "Private123")).status, 200);
      // …and the login page no longer prints any password.
      assert.equal((await client(srv.base).get("/config")).data.demo_password, null);
    } finally {
      srv.child.kill();
    }
  });
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
