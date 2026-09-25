# Anvil Trades Portal

A full-stack web app built from an ER diagram for a school project. Anvil helps
high-school students find a route into the skilled trades: it reads their resume,
matches them to training programs by cost and starting pay, and connects them to
verified local employers hiring apprentices.

Three account types, each with its own signup, views, and permissions:

| Role | What they do |
|---|---|
| **Student** | Create a profile, upload a resume for an AI scan, take the trade quiz, compare programs by cost and pay, apply to jobs, track applications |
| **Employer** | Register a company, post apprentice roles, move applicants through hiring stages |
| **Admin** | Verify employers, approve or reject postings before students can see them |

---

## Running it

You need **Node.js 18 or newer** (built and tested on 22). Nothing else — SQLite is
a file the seed script creates, and there is no build step for the backend.

Two processes, so open two terminals:

```bash
# terminal 1 — API on http://localhost:4000
cd server
npm install
npm run seed     # builds anvil.db from schema.sqlite.sql and loads demo data
npm run dev

# terminal 2 — web app on http://localhost:5173
cd client
npm install
npm run dev
```

Then open <http://localhost:5173>. Vite proxies `/api` to the API on :4000, so the
client uses the same relative URLs it uses in production.

To run it the way the deployed site runs — one process, one port — build the client
first and start only the server:

```bash
npm run build      # from the repo root
npm start          # http://localhost:4000, app and API together
```

`npm run seed` prints every demo login when it finishes. On your own computer the
password for all of them is `anvil1234` (a public deployment must use its own —
see [Putting it online](#putting-it-online)):

| Role | Email |
|---|---|
| Student | `jordan.ellis@student.test` |
| Employer | `hiring@carolinacurrentelectric.test` |
| Admin | `renee.alvarado@anvil.test` |

Or click **I'm a student** / **I'm an employer** on the login screen and create a new
account — signup creates the profile row and the login together.

### Tests

```bash
cd server
npm test                                         # 34 end-to-end API tests on SQLite
DATABASE_URL=postgres://user@host/db npm test    # the same tests on Postgres
```

Each run seeds a fresh database, starts the real server, and exercises it over
HTTP: sign-in and session revocation, who may change what, input checks, rate
limits, the resume matcher, distances, twelve signups racing at once, and the
production boot rules (no `JWT_SECRET` or `DEMO_PASSWORD`, no start). Needs Node 20+.

Re-running `npm run seed` wipes the database and starts over.

### Optional: the AI resume scan

The resume scan works with no configuration — it falls back to a keyword matcher and
labels itself **"Offline keyword match"** in the UI so nobody mistakes one for the other.

To get a real reading of the resume, copy `.env.example` to `server/.env` and set:

```
ANTHROPIC_API_KEY=sk-ant-...
```

`server/.env` is gitignored. If the default model id has been retired by the time you
run this, set `ANTHROPIC_MODEL` to a current one from
[the model list](https://docs.claude.com/en/docs/about-claude/models) — the code
doesn't hardcode a date-pinned id anywhere else.

---

## Putting it online

The app deploys as **one service**: Express serves the built React app and the API
from the same URL. That means one deploy, one host, and no CORS — the client uses
relative `/api` URLs, so nothing about the host name is baked into the build.

### What you need

| | |
|---|---|
| **The repo on GitHub** | Hosts deploy by watching a branch |
| **A host account** | Render, Railway and Fly.io all have a usable free tier |
| **`JWT_SECRET`** | Required. The server refuses to boot in production without it |
| **`DATABASE_URL`** | A Postgres connection string. Strongly recommended — see below |
| **`DEMO_PASSWORD`** | Required. The password for the demo accounts, admin included. The server refuses to boot in production without one, or with the public `anvil1234` |
| **`ANTHROPIC_API_KEY`** | Optional. Unset = the keyword matcher |
| **`ADZUNA_APP_ID` / `ADZUNA_APP_KEY`** | Optional. Unset = employer-posted jobs only |

`PORT` is set by the host. `NODE_ENV=production` turns on the production
behaviour (trust proxy, secure cookies, `JWT_SECRET` and `DEMO_PASSWORD`
required, demo password hidden from the login page).

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### SQLite or Postgres — pick by where you're deploying

The app runs on either, decided by one environment variable:

```
DATABASE_URL unset  ->  SQLite file      (zero setup; the local default)
DATABASE_URL set    ->  Postgres         (survives restarts; use this in public)
```

Nothing else changes: the queries are written once and translated in `db.js`,
and the two schema files differ only in storage types and timestamp defaults.
The API test suite passes identically against both.

**Why this matters for a public deployment.** Most free tiers give the
container a disk that is wiped on every restart and deploy. On SQLite that
means every signup disappears the next time the service sleeps. Postgres lives
outside the container, so it doesn't. [Neon](https://neon.tech) and
[Supabase](https://supabase.com) both have a free tier that is more than this
app needs; copy the connection string into `DATABASE_URL` and you're done.

If you'd rather stay on SQLite, attach a volume and set
`DATABASE_PATH=/data/anvil.db`. On Fly.io that's `fly volumes create anvil_data
--size 1`; on Render it's a paid disk.

Either way the server seeds itself when it finds an empty database, so a fresh
deploy is never a working app in front of empty tables.

### Render (free, ~5 minutes)

`render.yaml` provisions the web service **and a free Postgres**, wired
together:

1. Push to GitHub.
2. [render.com](https://render.com) → **New** → **Blueprint** → pick the repo.
   It reads `render.yaml`, creates the database, injects `DATABASE_URL`, and
   generates `JWT_SECRET`.
3. It asks for one value, **`DEMO_PASSWORD`** — type a password only you know
   (8+ characters, a letter and a number). Leave it blank and the deploy fails
   with a message saying so, on purpose.
4. Optionally set `ANTHROPIC_API_KEY` and the Adzuna keys.
5. Deploy. You get `https://anvil-trades.onrender.com` (or whatever you named it).

Render's free web tier sleeps after ~15 minutes idle, so the first visitor
after a quiet spell waits ~50 seconds for it to wake. The database does not
sleep, so nothing is lost.

### Anywhere that takes a Dockerfile

There's a `Dockerfile` for Railway, Fly.io, Cloud Run or a VPS. It builds the
client, drops the client's dev dependencies, and runs the server on `PORT`
(default 8080).

```bash
fly launch --now          # reads the Dockerfile
fly secrets set JWT_SECRET=... DEMO_PASSWORD=... DATABASE_URL=...
```

### Two things to know before you share the link

**1. The demo accounts use `DEMO_PASSWORD`, not the README's password.** The
server won't start in production without a private one, and the login page on
the live site lists the demo emails but not the password — give it only to
whoever needs it (your teacher, say). A site deployed before this rule existed
is fixed on its next boot: any demo account still on `anvil1234` is moved to
`DEMO_PASSWORD` and signed out.

**2. If you set an API key, visitors spend your money.** Every resume scan on
the live site is billed to your Anthropic account, and every feed sync counts
against your Adzuna quota. Each student gets 20 scans an hour, and the whole
site gets at most `AI_SCANS_PER_HOUR` AI scans (default 60) — past that, scans
fall back to the keyword matcher instead of billing you. Feed syncs are capped
at 6 an hour. For a public demo, leaving the key unset is the safe default —
the keyword matcher still produces real recommendations and labels itself
honestly.

### Health check

`GET /api/health` returns `{"ok": true, "ai_enabled": false}` — point your host's
health check at it so a failed boot shows up as a failed deploy.


---

## The data model

`server/schema.sqlite.sql` is the whole schema, commented (`schema.postgres.sql`
is the same model for Postgres, kept in step). It came from the project ER
diagram, with three deliberate departures — each explained in a comment at its site,
and all three are worth defending in a writeup.

```
admins ──────────┐
                 ├──< job_postings >──── employers
                 │          │
students ──┬─────┼──────────┴──< applications
           │     │
           ├──< quiz_results
           └──1:1── resumes

programs   (standalone; `trade` is a plain label)
users ──1:1──> (students | employers | admins)
users ──< sessions
```

**Relationships**

- `employers` **1 : N** `job_postings` — a company owns its postings
- `admins` **1 : N** `job_postings` — the admin who reviewed the posting
- `students` **1 : N** `quiz_results` — each submission is a row
- `students` **1 : 1** `resumes` — one current resume, replaced on re-upload
- `students` **M : N** `job_postings`, resolved by `applications`, with a
  `UNIQUE (student_id, job_id)` constraint so nobody applies twice

### The three departures from the diagram

**1. `trade_pathways` was removed.** The diagram had a lookup table that `programs`
pointed at with a foreign key, holding wage and debt once per trade. It's gone.
`trade` is now a plain category label on `programs`, and each program carries its own
`avg_starting_wage`, `avg_debt` and `time_to_certify`.

The cost: the label is no longer constrained, so a typo makes a new "trade" and
renaming one means an `UPDATE` across rows. What we get back is accuracy — two
providers teaching the same trade genuinely produce different starting wages,
different debt and different program lengths. Those figures were never really
properties of the trade, and a student choosing between two welding programs has to
see the difference. The quiz still works: it scores the distinct `trade` values found
in the catalog rather than rows in a table.

**2. `users` was added.** The diagram models the *domain*; credentials are an
application concern. Keeping them in their own table means a `CHECK` constraint can
enforce that a student account carries a `student_id` and nothing else — the profile
link can't drift from the role.

**3. `resumes` and `sessions` were added.** `sessions` is what makes signing
out actually revoke a token; see Auth below.

**3b. `resumes`.** It stores the *extracted text*, never the uploaded file.
The text is all the matcher needs, and storing binaries would mean a file store and a
much larger privacy surface. `engine` records whether a model or the keyword matcher
produced the analysis, so the UI can never pass one off as the other.

### Two other decisions worth explaining

- **`open_jobs` is a view, not a query the client assembles.** A posting reaches
  students only if it is `approved` **and** its employer is `verified`. Putting that
  rule in one view means the job board and the "can this student apply" check can't
  disagree.
- **`answers` is a JSON array in a `TEXT` column.** The diagram types it `list`, which
  SQLite has no equivalent for; `CHECK (json_valid(answers))` keeps it honest. The
  normalized alternative is a `quiz_answers` child table, one row per question.

---

## The resume scan

`server/resume.js` does three things, and both paths return the **same shape** so the
client renders one component either way:

1. **Extract** — PDF via `pdfjs-dist`, Word via `mammoth`, plain text as-is. Files are
   held in memory (5 MB cap) and never written to disk.
2. **Match** — the resume text plus the full program and job catalogs go to Claude,
   which returns structured JSON. With no API key, a transparent keyword matcher runs
   instead and says so.
3. **Sanitize** — every recommended `program_id` and `job_id` is checked against the
   database before it renders. A model that invents an id gets that recommendation
   dropped rather than rendering a broken row.

The prompt tells the model it may only recommend ids from the supplied catalogs, and
never to invent a certification or skill the resume doesn't show. Step 3 is what
enforces it.

---

## Geolocation

Students, employers and programs each carry `latitude`/`longitude`, and the
board and program list can sort by how far away something is.

**Geocoding** turns "Apex, NC" into coordinates using free, keyless services,
picked by what was typed: [Zippopotam.us](https://api.zippopotam.us) for a ZIP
code, [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api) for a
town ("Greenville, NC" — the state picks the right Greenville), and the [US Census
Geocoder](https://geocoding.geo.census.gov) for a full street address. (The Census
service only matches street addresses; asked for a town on its own it finds
nothing, which is why it can't be the only lookup for a "City and state" field.)
No key, no card. `geo.js` also keeps a small offline table of the towns in the
seed data, so `npm run seed` never depends on the network.

**Coordinates are always optional.** If a geocoder is unreachable or doesn't
recognise a place, the lookup returns null, the row keeps null coordinates, and
distances simply don't render. Nothing fails. Rows with unknown coordinates sort
*last* rather than being treated as near or far.

**"Use my location"** asks the browser and stores the fix on the student's
profile, which overrides the geocoded town. A denied permission is a message,
not an error.

**Distance is computed in JavaScript**, not SQL — SQLite has no trig functions
without a compiled extension, and Postgres would need `earthdistance` or
PostGIS. Doing the haversine in `geo.js` keeps one code path for both engines,
and the result sets here are far too small for it to matter. At a scale where
it did, this is the first thing to push into the database.

Distance also reaches the resume scan: each program and job is passed to the
matcher with `miles_from_student`, so it can prefer a provider 12 miles away
over an identical one 200 miles away.

---

## Job feeds

Employers post jobs themselves — that's the primary model. On top of that,
`jobfeeds.js` can import real listings from two optional sources:

| Feed | Cost | Credentials |
|---|---|---|
| [Adzuna](https://developer.adzuna.com) | Free tier, self-serve | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| [CareerOneStop](https://www.careeronestop.org/Developers/WebAPI/web-api.aspx) (US Dept of Labor) | Free, registration | `COS_USER_ID`, `COS_TOKEN` |

With neither configured the app runs exactly as before. Both adapters return
the same normalized row, so adding a third feed means adding one function.

```bash
npm run sync:jobs     # or the Job feed screen in the admin UI
```

The sync is idempotent — `(source, source_ref)` is unique, so re-running
refreshes rows instead of duplicating them. It's safe on a cron schedule.

### The rule that shapes the whole feature

**An imported job can never be applied to through this app.** There is no
employer account behind it to receive the application, so:

- `job_postings.source` separates imported rows from employer-posted ones.
- Imported rows carry their own `company_name`, `location` and `source_url`
  instead of joining to an employer.
- They skip the review queue — they were already public somewhere else.
- `POST /api/applications` refuses them, and the UI renders an outbound link
  rather than an Apply button.

Without that rule you build an application pipeline that quietly drops
applications where nobody will ever read them.

---

## Auth

- **Passwords** are hashed with bcrypt (`bcryptjs`, 10 rounds). Plaintext is
  never stored, logged, or returned by any endpoint.
- **Sessions are revocable.** A bare JWT can't be taken back — it stays valid
  until it expires, so "sign out" would only delete the browser's copy while a
  stolen token kept working for a week. The token carries a session id that is
  checked against the `sessions` table on every request, so signing out really
  revokes, and **sign out everywhere** revokes every device at once. Changing a
  password revokes all other sessions too.
- **The token lives only in an httpOnly cookie.** Page scripts can't read it, the
  API never returns it in a response body, and the client never stores it, so a
  script injected into the page has nothing to steal. `Secure` and
  `SameSite=Lax` are set in production; Lax also stops other websites from
  making signed-in changes. CORS is off unless you set `CORS_ORIGIN`.
- **A wrong password and an unknown email return the same message**, so the
  login form can't be used to discover which emails have accounts.
- **Ownership is checked per row, not just per role.** `requireRole("employer")`
  only proves the caller is *an* employer; `ownsEmployer()` proves they own the
  specific posting. Ids for writes come from the token, never the request body.
- **Boundaries the API enforces, not just the UI:** employers cannot set their
  own `verified` flag, cannot publish without admin approval, and only see their
  own drafts. Students can only ever move an application to `withdrawn`, and
  once they have, the employer can't move it back. Admins can read the student
  roster but not edit anyone's profile.
- **Every field is checked** for type and length before it reaches the
  database, so a bad value gets a clear 400 rather than a crash.
- **Rate limits count per account, not per IP.** A school's Wi-Fi usually
  shares one public address, and a per-IP limit would lock a whole class out.
  Sign-in allows 10 *wrong* passwords per email per 15 minutes (correct ones
  don't count); each student gets 30 uploads and 20 scans an hour; feed syncs
  are capped at 6 an hour site-wide.

**Not built, and worth saying so:** there is no email verification and no
password reset, because both need a mail service and this has none. Anyone can
sign up as any address. That is the honest gap in this implementation.

---

## API

| Method | Route | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup/student` | public | Create student profile + account |
| POST | `/api/auth/signup/employer` | public | Create company profile + account |
| POST | `/api/auth/login` | public | Sign in; sets the session cookie |
| GET | `/api/auth/me` | public | Current account and profile (nulls when signed out) |
| PATCH | `/api/auth/password` | any | Change password |
| POST | `/api/auth/logout` | any | Revoke this session |
| POST | `/api/auth/logout-all` | any | Revoke every session for the account |
| GET | `/api/auth/sessions` | any | Active sessions for the account |
| GET | `/api/config` | public | Whether the AI scan and feeds are configured; the demo password outside production |
| GET | `/api/programs` | public | Filter by trade/city, sort by cost, wage, payback or distance |
| GET | `/api/trades` | public | Distinct trades with headline numbers |
| PUT | `/api/students/:id/location` | owner | Store browser coordinates |
| GET | `/api/feeds` | admin | Feed status and import counts |
| POST | `/api/feeds/sync` | admin | Pull from the configured feeds |
| GET | `/api/jobs` | public | The `open_jobs` board; `?sort=distance`, `?source=` |
| GET | `/api/resumes/me` | student | Current resume + analysis |
| POST | `/api/resumes` | student | Upload a file or post text |
| POST | `/api/resumes/me/analysis` | student | Run the scan |
| DELETE | `/api/resumes/me` | student | Remove it |
| GET | `/api/students` | admin | Roster |
| PATCH | `/api/students/:id` | owner | Edit profile |
| PATCH | `/api/employers/:id` | owner | Edit company |
| PATCH | `/api/employers/:id/verification` | admin | Grant / revoke verification |
| GET | `/api/postings` | employer, admin | All postings incl. pending |
| POST/PATCH/DELETE | `/api/postings[/:id]` | owner | Posting CRUD |
| PATCH | `/api/postings/:id/moderation` | admin | Approve / reject |
| GET | `/api/applications` | any | Scoped to the caller |
| POST | `/api/applications` | student | Apply |
| PATCH | `/api/applications/:id` | student, employer | Withdraw / advance stage |
| GET | `/api/quiz`, `/api/quiz/me` | public, student | Questions / last result |
| POST | `/api/quiz` | student | Submit and score |
| GET | `/api/stats` | admin | Dashboard counts |

Quiz scoring runs on the server (`server/quiz.js`) — the client only sends option indexes.

---

## Layout

```
server/
  schema.sqlite.sql    the data model for SQLite
  schema.postgres.sql  the same model for Postgres
  db.js                driver selection, SQL translation, transactions
  seed.js              rebuild + demo rows + demo accounts + geocoding
  auth.js              bcrypt, revocable sessions, cookies, ownership checks
  geo.js               geocoding, haversine distance, coordinate validation
  jobfeeds.js          Adzuna + CareerOneStop adapters, idempotent sync
  sync-jobs.js         `npm run sync:jobs`
  quiz.js              questions, trade weights, scoring
  resume.js            text extraction, the prompt, sanitizing, keyword fallback
  index.js             every route
client/
  src/api.js       fetch wrapper (the session cookie is sent by the browser)
  src/auth.jsx     React context: who's signed in
  src/ui.jsx       Panel, Table, Tag, Stat, useAsync
  src/App.jsx      shell, sidebar, routing
  src/pages/       Auth, Student, Resume, Employer, Admin
  src/styles.css   design tokens, light + dark
```

## A note on the data

Wage, debt, cost and time-to-certify figures are plausible demo values modeled on
public occupational data, and the schools, companies and people are invented. They
are placeholders for a real data feed — don't cite them as statistics.
