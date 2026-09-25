/**
 * One data layer, two engines.
 *
 *   DATABASE_URL set  ->  Postgres (Neon, Supabase, Railway, anything)
 *   DATABASE_URL unset ->  a local SQLite file
 *
 * Why both: Postgres is what you want on a host whose disk is wiped on every
 * restart — which is most free tiers — but requiring it locally would mean
 * nobody can clone this repo and run it without provisioning a database
 * first. SQLite is the zero-setup default; Postgres is one environment
 * variable away.
 *
 * Every query in this app is written once, in SQLite-flavoured SQL with `?`
 * placeholders, and translated for Postgres here. The translation is small on
 * purpose — see `toPg` — and everything that could NOT be translated cheaply
 * (json_valid checks, boolean storage, timestamp defaults) was kept out of the
 * shared SQL and pushed into the two schema files instead.
 *
 * The API is async for both engines. better-sqlite3 is synchronous, but
 * pretending it isn't keeps route code identical across the two.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const DATABASE_URL = process.env.DATABASE_URL || "";
export const DIALECT = DATABASE_URL ? "postgres" : "sqlite";
export const DB_PATH = process.env.DATABASE_PATH || path.join(here, "anvil.db");

/* ============================================================
   SQL TRANSLATION
   ============================================================ */

/**
 * `?, ?, ?` -> `$1, $2, $3`, and LIKE -> ILIKE.
 *
 * SQLite's LIKE is case-insensitive for ASCII and Postgres's is not, so a
 * plain translation would silently break every search box. ILIKE restores the
 * behaviour the queries were written against.
 *
 * Question marks inside string literals would be mangled by this, so no query
 * in this app puts one there.
 */
function toPg(text) {
  let i = 0;
  return text
    .replace(/\?/g, () => `$${++i}`)
    .replace(/\bLIKE\b/gi, "ILIKE");
}

/* ============================================================
   DRIVERS
   ============================================================ */

let driver;

if (DIALECT === "postgres") {
  const { default: pg } = await import("pg");

  // Hosted Postgres almost always requires TLS, and almost always presents a
  // certificate Node won't chain to a root it knows. Neon, Supabase, Render
  // and Heroku all land here. Local connections get no TLS at all.
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5
  });

  driver = {
    async all(text, params) {
      const res = await pool.query(toPg(text), params);
      return res.rows;
    },
    async get(text, params) {
      const res = await pool.query(toPg(text), params);
      return res.rows[0];
    },
    async run(text, params) {
      const res = await pool.query(toPg(text), params);
      return { changes: res.rowCount };
    },
    async exec(text) {
      await pool.query(text);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const scoped = {
          all: async (t, p) => (await client.query(toPg(t), p)).rows,
          get: async (t, p) => (await client.query(toPg(t), p)).rows[0],
          run: async (t, p) => ({ changes: (await client.query(toPg(t), p)).rowCount })
        };
        const out = await fn(scoped);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); }
  };
} else {
  const { default: Database } = await import("better-sqlite3");

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  driver = {
    async all(text, params) { return sqlite.prepare(text).all(params); },
    async get(text, params) { return sqlite.prepare(text).get(params); },
    async run(text, params) {
      const info = sqlite.prepare(text).run(params);
      return { changes: info.changes };
    },
    async exec(text) { sqlite.exec(text); },
    async tx(fn) {
      // better-sqlite3's own transaction helper cannot wrap an async
      // function, so the BEGIN/COMMIT is written out by hand.
      sqlite.exec("BEGIN");
      try {
        const scoped = {
          all: async (t, p) => sqlite.prepare(t).all(p),
          get: async (t, p) => sqlite.prepare(t).get(p),
          run: async (t, p) => ({ changes: sqlite.prepare(t).run(p).changes })
        };
        const out = await fn(scoped);
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
    async close() { sqlite.close(); }
  };
}

/* ============================================================
   PUBLIC API
   ============================================================ */

export const all = (text, ...params) => driver.all(text, params);
export const get = (text, ...params) => driver.get(text, params);
export const run = (text, ...params) => driver.run(text, params);
export const tx = fn => driver.tx(fn);
export const close = () => driver.close();

/** Apply the schema for whichever engine is in use. */
export async function createSchema() {
  const file = DIALECT === "postgres" ? "schema.postgres.sql" : "schema.sqlite.sql";
  await driver.exec(fs.readFileSync(path.join(here, file), "utf8"));
}

/** True when the database has no schema yet — a brand-new deployment. */
export async function isEmpty() {
  const row = DIALECT === "postgres"
    ? await get("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'students'")
    : await get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'students'");
  return Number(row.n) === 0;
}

/** Generate the next id in a `prefix-NN` sequence for a table. */
export async function nextId(table, column, prefix) {
  const rows = await all(`SELECT ${column} AS id FROM ${table}`);
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.id).split("-")[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(2, "0")}`;
}

/** True for "that row already exists" from either engine. */
export function isUniqueViolation(err) {
  return err?.code === "23505"                                     // Postgres
    || /^SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)$/.test(err?.code || ""); // SQLite
}

/** True only when the clash was on a table's primary key — i.e. its id. */
function isPrimaryKeyViolation(err) {
  return (err?.code === "23505" && /_pkey$/.test(err.constraint || ""))
    || err?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

/**
 * Run `fn` — which picks an id with nextId and inserts with it — and if a
 * request running at the same moment took that id first, pick again.
 *
 * nextId counts the rows that exist, so two requests can both see "st-07 is
 * next" before either has inserted. Postgres (a real server with a connection
 * pool) makes that genuinely possible. Without this the loser gets a 500.
 * Any other error, including a duplicate EMAIL, is passed straight through.
 */
export async function retryOnIdClash(fn, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isPrimaryKeyViolation(err)) throw err;
      // A short random pause, growing each time, so the requests that
      // collided don't all pick the same next id again in lockstep.
      await new Promise(r => setTimeout(r, Math.random() * 20 * i));
    }
  }
}

/** ISO timestamp in the shape both schemas store. */
export const nowStamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export function describe() {
  return DIALECT === "postgres"
    ? `Postgres (${DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@")})`
    : `SQLite (${DB_PATH})`;
}
