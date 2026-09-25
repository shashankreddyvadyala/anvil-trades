/**
 * Drops the database, rebuilds it from the schema file for the engine in use
 * (schema.sqlite.sql or schema.postgres.sql), and loads demo rows.
 * Run with:  npm run seed
 *
 * Wage and debt figures are plausible demo values modeled on public
 * occupational data. They are placeholders for a real data feed, not
 * live statistics — do not cite them as fact.
 */
import { pathToFileURL } from "node:url";
import { createSchema, run, get, all, describe, close } from "./db.js";
import { hashPassword, checkPassword, passwordProblem } from "./auth.js";
import { geocode } from "./geo.js";

const PRODUCTION = process.env.NODE_ENV === "production";

/** The password this repo publishes. Fine on your own laptop, never online. */
export const PUBLIC_DEMO_PASSWORD = "anvil1234";

/**
 * Every demo account uses this password.
 *
 * On your own computer it defaults to the published one so the app works
 * straight after cloning. On a public deployment that default would let
 * anyone who has read the README sign in as the admin — so production
 * refuses to start without a private one. See `requireDemoPassword`.
 */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || PUBLIC_DEMO_PASSWORD;

/**
 * Stop a production server that would otherwise run with the published
 * password. Same idea as the JWT_SECRET check in auth.js: fail loudly at boot
 * instead of quietly running insecure.
 */
export function requireDemoPassword() {
  if (!PRODUCTION) return;
  const pw = process.env.DEMO_PASSWORD;
  const problem =
    !pw ? "DEMO_PASSWORD is not set."
    : pw === PUBLIC_DEMO_PASSWORD ? "DEMO_PASSWORD is still the public default from the README."
    : passwordProblem(pw);
  if (problem) {
    console.error(
      `\n${problem}\n` +
      "The demo accounts (including the admin) use this password, so on a public site it must be private.\n" +
      "Set DEMO_PASSWORD in your host's environment variables to something only you know —\n" +
      "at least 8 characters with a letter and a number — then redeploy.\n"
    );
    process.exit(1);
  }
}

const admins = [
  ["ad-01", "Renee Alvarado", "Triangle (Wake / Durham / Orange)"],
  ["ad-02", "Marcus Webb", "Eastern NC"]
];

const students = [
  ["st-01", "Jordan Ellis",   "Apex Friendship High School",   2027, "Apex, NC"],
  ["st-02", "Maya Whitfield", "Southeast Raleigh Magnet HS",   2026, "Raleigh, NC"],
  ["st-03", "Devin Carter",   "Hillside High School",          2027, "Durham, NC"],
  ["st-04", "Alina Popescu",  "Panther Creek High School",     2026, "Cary, NC"],
  ["st-05", "Tre Boykin",     "Rocky Mount High School",       2027, "Rocky Mount, NC"],
  ["st-06", "Sofia Delgado",  "Garner Magnet High School",     2028, "Garner, NC"]
];

const employers = [
  ["em-01", "Carolina Current Electric",    "Electrical Contracting", "Raleigh, NC",     1],
  ["em-02", "Piedmont Mechanical",          "HVAC & Plumbing",        "Durham, NC",      1],
  ["em-03", "Tarheel Fabrication",          "Metal Fabrication",      "Garner, NC",      1],
  ["em-04", "Neuse Diesel Works",           "Fleet Maintenance",      "Clayton, NC",     0],
  ["em-05", "Bright Ridge Solar",           "Renewable Energy",       "Cary, NC",        1],
  ["em-06", "Cardinal Millwright Services", "Industrial Services",    "Rocky Mount, NC", 0]
];

const programs = [
  // program_id, trade, provider, location, cost, time_to_certify, avg_starting_wage, avg_debt, data_source
  ["pg-01", "Electrical",               "IBEW Local 553 JATC",         "Raleigh, NC",      1800, "4-yr paid apprenticeship", 63900, 2400, "IBEW Local 553 + BLS OES 2024"],
  ["pg-02", "Electrical",               "Wake Tech Community College", "Raleigh, NC",      4960, "18-mo AAS degree",         58200, 5100, "NC Community College System + BLS OES 2024"],
  ["pg-03", "Electrical",               "Fayetteville Tech CC",        "Fayetteville, NC", 4480, "18-mo AAS degree",         55400, 4800, "NCCCS + BLS OES 2024"],
  ["pg-04", "Welding & Fabrication",    "Durham Technical CC",         "Durham, NC",       3740, "9-mo certificate",         52600, 4200, "AWS + BLS OES 2024"],
  ["pg-05", "Welding & Fabrication",    "Johnston Community College",  "Smithfield, NC",   3120, "9-mo certificate",         50900, 3600, "AWS + BLS OES 2024"],
  ["pg-06", "HVAC/R",                   "Wake Tech Community College", "Raleigh, NC",      5280, "18-mo AAS degree",         57300, 6100, "NCCCS + BLS OES 2024"],
  ["pg-07", "HVAC/R",                   "Guilford Tech CC",            "Jamestown, NC",    5020, "18-mo AAS degree",         55100, 5700, "NCCCS + BLS OES 2024"],
  ["pg-08", "Plumbing & Pipefitting",   "UA Local 421 Apprenticeship", "Charlotte, NC",    1500, "5-yr paid apprenticeship", 59700, 1900, "UA Local 421 + BLS OES 2024"],
  ["pg-09", "Diesel & Heavy Equipment", "Nash Community College",      "Rocky Mount, NC",  6400, "12-mo certificate",        54300, 7100, "NCCCS + BLS OES 2024"],
  ["pg-10", "Powerline",                "Nash CC Lineworker Academy",  "Rocky Mount, NC",  8900, "15-wk pre-apprenticeship", 74500, 9400, "EEI + BLS OES 2024"],
  ["pg-11", "CNC Machining",            "Central Carolina CC",         "Sanford, NC",      4100, "12-mo certificate",        52900, 4600, "NIMS + BLS OES 2024"],
  ["pg-12", "Industrial Millwright",    "Wake Tech Apprenticeship",    "Raleigh, NC",      2200, "4-yr paid apprenticeship", 63800, 2800, "UBC + BLS OES 2024"],
  ["pg-13", "Automotive",               "Durham Technical CC",         "Durham, NC",       5150, "18-mo AAS degree",         47600, 5900, "ASE + BLS OES 2024"],
  ["pg-14", "Solar PV",                 "Cape Fear CC",                "Wilmington, NC",   3350, "6-mo certificate",         49800, 3700, "NABCEP + BLS OES 2024"]
];

const jobs = [
  ["jb-01", "em-01", "ad-01", "Apprentice Electrician",        "$22-$26/hr", "approved"],
  ["jb-02", "em-01", "ad-01", "Journeyman Electrician",        "$31-$38/hr", "approved"],
  ["jb-03", "em-01", "ad-01", "Low-Voltage Technician",        "$20-$25/hr", "rejected"],
  ["jb-04", "em-02", "ad-01", "HVAC Install Helper",           "$19-$23/hr", "approved"],
  ["jb-05", "em-02", "ad-01", "Service Plumber",               "$28-$34/hr", "approved"],
  ["jb-06", "em-02", "ad-01", "Sheet Metal Fabricator",        "$25-$30/hr", "approved"],
  ["jb-07", "em-03", "ad-01", "MIG Welder - 2nd Shift",        "$24-$29/hr", "approved"],
  ["jb-08", "em-03", "ad-01", "CNC Machine Operator",          "$21-$25/hr", "pending"],
  ["jb-09", "em-04", "ad-02", "Diesel Technician I",           "$23-$27/hr", "pending"],
  ["jb-10", "em-05", "ad-01", "Solar PV Installer",            "$20-$24/hr", "approved"],
  ["jb-11", "em-05", "ad-01", "Crew Lead - Residential Solar", "$27-$32/hr", "approved"],
  ["jb-12", "em-06", "ad-02", "Millwright Apprentice",         "$21-$26/hr", "pending"]
];

const applications = [
  ["ap-01", "st-01", "jb-01", "interview", "2026-08-24 14:10:00"],
  ["ap-02", "st-01", "jb-04", "submitted", "2026-09-02 09:35:00"],
  ["ap-03", "st-02", "jb-07", "reviewing", "2026-08-29 16:02:00"],
  ["ap-04", "st-02", "jb-10", "offer",     "2026-08-11 11:20:00"],
  ["ap-05", "st-03", "jb-02", "rejected",  "2026-07-30 13:45:00"],
  ["ap-06", "st-04", "jb-11", "submitted", "2026-09-05 10:05:00"],
  ["ap-07", "st-05", "jb-12", "reviewing", "2026-09-01 08:50:00"],
  ["ap-08", "st-06", "jb-05", "submitted", "2026-09-08 15:30:00"]
];

const quizzes = [
  ["qz-01", "st-01", JSON.stringify([0, 0, 1, 2, 0, 0])],
  ["qz-02", "st-02", JSON.stringify([1, 1, 0, 0, 2, 1])]
];

async function insertAll(sql, rows) {
  for (const row of rows) await run(sql, ...row);
}

/** Look up coordinates for a place, tolerating a geocoder that is unreachable. */
async function coordsFor(place) {
  const point = await geocode(place);
  return [point?.latitude ?? null, point?.longitude ?? null];
}

/* One login account per profile row, with addresses derived from the names
   so the demo list stays in step with the rows above. */
const slug = name => name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");

const accounts = [
  ...students.map(([student_id, name], i) =>
    [`us-${String(i + 1).padStart(2, "0")}`, `${slug(name)}@student.test`, "student", student_id, null, null]),
  ...employers.map(([employer_id, company], i) =>
    [`us-${String(students.length + i + 1).padStart(2, "0")}`,
     `hiring@${slug(company).replace(/\./g, "")}.test`, "employer", null, employer_id, null]),
  ...admins.map(([admin_id, name], i) =>
    [`us-${String(students.length + employers.length + i + 1).padStart(2, "0")}`,
     `${slug(name)}@anvil.test`, "admin", null, null, admin_id])
];

/**
 * Fix a site that was deployed before DEMO_PASSWORD was required: any demo
 * account still accepting the published password is moved to the private
 * one. Only the seeded demo emails are touched — never a real signup.
 * Returns how many accounts were updated.
 */
export async function rotateDemoPasswords() {
  if (DEMO_PASSWORD === PUBLIC_DEMO_PASSWORD) return 0;
  const emails = accounts.map(a => a[1]);
  const rows = await all(
    `SELECT user_id, email, password_hash FROM users WHERE email IN (${emails.map(() => "?").join(",")})`,
    ...emails
  );
  const stale = rows.filter(r => checkPassword(PUBLIC_DEMO_PASSWORD, r.password_hash));
  if (!stale.length) return 0;
  const hash = hashPassword(DEMO_PASSWORD);
  for (const r of stale) await run("UPDATE users SET password_hash = ? WHERE user_id = ?", hash, r.user_id);
  // Anyone signed in with the old password is signed out.
  for (const r of stale) await run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                                   new Date().toISOString().slice(0, 19).replace("T", " "), r.user_id);
  return stale.length;
}

/** Rebuild the schema and load every demo row. Safe to call on boot. */
export async function seed({ quiet = false } = {}) {
  requireDemoPassword();
  await createSchema();

  await insertAll("INSERT INTO admins (admin_id, name, managed_region) VALUES (?,?,?)", admins);

  // Students, employers and programs all get coordinates so distance sorting
  // works out of the box. geo.js has an offline table for these towns, so
  // seeding never depends on the network.
  for (const [student_id, name, school, grad_year, location] of students) {
    const [lat, lon] = await coordsFor(location);
    await run(
      "INSERT INTO students (student_id, name, school, grad_year, location, latitude, longitude) VALUES (?,?,?,?,?,?,?)",
      student_id, name, school, grad_year, location, lat, lon
    );
  }

  for (const [employer_id, company_name, industry, location, verified] of employers) {
    const [lat, lon] = await coordsFor(location);
    await run(
      "INSERT INTO employers (employer_id, company_name, industry, location, latitude, longitude, verified) VALUES (?,?,?,?,?,?,?)",
      employer_id, company_name, industry, location, lat, lon, verified
    );
  }

  for (const [program_id, trade, provider_name, location, cost, time_to_certify, wage, debt, source] of programs) {
    const [lat, lon] = await coordsFor(location);
    await run(
      `INSERT INTO programs (program_id, trade, provider_name, location, latitude, longitude,
                             cost, time_to_certify, avg_starting_wage, avg_debt, data_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      program_id, trade, provider_name, location, lat, lon, cost, time_to_certify, wage, debt, source
    );
  }

  await insertAll(
    "INSERT INTO job_postings (job_id, source, employer_id, admin_id, title, wage_range, status) VALUES (?,'employer',?,?,?,?,?)",
    jobs
  );
  await insertAll("INSERT INTO applications (application_id, student_id, job_id, status, applied_date) VALUES (?,?,?,?,?)", applications);
  await insertAll("INSERT INTO quiz_results (quiz_id, student_id, answers) VALUES (?,?,?)", quizzes);

  /* Login accounts — one per profile row. The password hash is computed
     here, so no plaintext ever reaches the database. */
  const hash = hashPassword(DEMO_PASSWORD);
  await insertAll(
    "INSERT INTO users (user_id, email, password_hash, role, student_id, employer_id, admin_id) VALUES (?,?,?,?,?,?,?)",
    accounts.map(([user_id, email, role, student_id, employer_id, admin_id]) =>
      [user_id, email, hash, role, student_id, employer_id, admin_id])
  );

  if (quiet) return;

  const tables = ["admins", "students", "employers", "programs", "job_postings",
                  "applications", "quiz_results", "users"];
  const counts = [];
  for (const t of tables) {
    const row = await get(`SELECT COUNT(*) AS n FROM ${t}`);
    counts.push(`${t}=${row.n}`);
  }

  console.log(`Seeded ${describe()}`);
  console.log("  " + counts.join("  "));
  console.log(`\nDemo logins (password for all: ${DEMO_PASSWORD})`);
  for (const [, email, role] of accounts) console.log(`  ${role.padEnd(9)} ${email}`);
}

/* Only runs the seed when this file is executed directly (`npm run seed`),
   not when index.js imports it to seed a fresh deployment. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seed();
  await close();
}
