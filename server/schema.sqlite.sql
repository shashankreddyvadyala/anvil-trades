-- ============================================================
--  Anvil Trades Portal — SQLite schema
--
--  Keep this in step with schema.postgres.sql. The differences
--  between the two are deliberately small: storage types,
--  timestamp defaults, and the json_valid check that only
--  SQLite has. Everything else is identical, which is what lets
--  every query in the app be written once.
--
--  Based on the project ER diagram, with three departures, each
--  explained at its site: `trade_pathways` removed, `users` and
--  `resumes` added.
-- ============================================================

DROP VIEW  IF EXISTS open_jobs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS resumes;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS job_postings;
DROP TABLE IF EXISTS quiz_results;
DROP TABLE IF EXISTS programs;
DROP TABLE IF EXISTS employers;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS admins;

-- ------------------------------------------------------------
-- admins — regional moderators who verify employers and review
-- job postings before students can see them.
-- ------------------------------------------------------------
CREATE TABLE admins (
  admin_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  managed_region  TEXT NOT NULL
);

-- ------------------------------------------------------------
-- students — the primary end user.
--
-- latitude/longitude are filled in by geocoding `location` when
-- the profile is saved, or written directly when the student
-- lets the browser share their position. Null is normal and the
-- app degrades to no distance sorting rather than breaking.
-- ------------------------------------------------------------
CREATE TABLE students (
  student_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  school      TEXT NOT NULL,
  grad_year   INTEGER NOT NULL CHECK (grad_year BETWEEN 2000 AND 2100),
  location    TEXT NOT NULL,
  latitude    REAL,
  longitude   REAL
);

-- ------------------------------------------------------------
-- employers — companies that post jobs. `verified` is written
-- only by an admin; unverified employers' jobs stay hidden.
-- ------------------------------------------------------------
CREATE TABLE employers (
  employer_id   TEXT PRIMARY KEY,
  company_name  TEXT NOT NULL,
  industry      TEXT NOT NULL,
  location      TEXT NOT NULL,
  latitude      REAL,
  longitude     REAL,
  verified      INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);

-- ------------------------------------------------------------
-- programs — a training provider's offering, and what it leads to.
--
-- NOTE ON THE MODEL: an earlier draft had a separate `trade_pathways`
-- table that programs pointed at with a foreign key, holding the wage
-- and debt figures once per trade. That table is gone. `trade` is now a
-- plain category label on the program, and each program carries its own
-- outcome figures.
--
-- The trade-off, stated plainly: the trade label is no longer
-- constrained by a lookup table, so a typo makes a new "trade" and
-- renaming one means an UPDATE across rows. What we get back is
-- accuracy — two providers teaching the same trade genuinely produce
-- different starting wages, different debt and different program
-- lengths, and a student choosing between them has to see that. The
-- figures were never really properties of the trade.
-- ------------------------------------------------------------
CREATE TABLE programs (
  program_id         TEXT PRIMARY KEY,
  trade              TEXT NOT NULL,
  provider_name      TEXT NOT NULL,
  location           TEXT NOT NULL,
  latitude           REAL,
  longitude          REAL,
  cost               INTEGER NOT NULL CHECK (cost >= 0),
  time_to_certify    TEXT NOT NULL,
  avg_starting_wage  INTEGER NOT NULL CHECK (avg_starting_wage >= 0),
  avg_debt           INTEGER NOT NULL CHECK (avg_debt >= 0),
  data_source        TEXT NOT NULL
);

-- ------------------------------------------------------------
-- quiz_results — one submission per row. `answers` is a JSON
-- array of option indexes; SQLite has no list type, so the
-- ERD's `list` is stored as JSON text and validated here.
-- ------------------------------------------------------------
CREATE TABLE quiz_results (
  quiz_id     TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL,
  answers     TEXT NOT NULL CHECK (json_valid(answers)),
  FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- job_postings — either owned by an employer on this platform,
-- or imported from an outside feed.
--
-- `source` is what separates the two, and it decides everything
-- downstream. An employer-posted job has an employer_id, goes
-- through admin review, and can receive an application here. An
-- imported job has no employer account behind it, so it carries
-- its own company/location text, skips review (it is already
-- public on someone else's site), and links out — a student must
-- never be able to "apply" through us to a job we merely copied,
-- because nobody on our side would ever receive it.
-- ------------------------------------------------------------
CREATE TABLE job_postings (
  job_id         TEXT PRIMARY KEY,
  source         TEXT NOT NULL DEFAULT 'employer',
  employer_id    TEXT,
  admin_id       TEXT,
  title          TEXT NOT NULL,
  wage_range     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Imported rows only, mirroring what an employer row gets from its join.
  company_name   TEXT,
  location       TEXT,
  latitude       REAL,
  longitude      REAL,
  source_url     TEXT,
  source_ref     TEXT,
  imported_at    TEXT,
  -- An employer-posted job must have an employer; an imported one must
  -- have somewhere to send the applicant.
  CHECK (
       (source = 'employer' AND employer_id IS NOT NULL)
    OR (source <> 'employer' AND source_url IS NOT NULL)
  ),
  UNIQUE (source, source_ref),
  FOREIGN KEY (employer_id) REFERENCES employers (employer_id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id)    REFERENCES admins (admin_id)       ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- applications — the join between students and job_postings.
-- A student may apply to a given posting only once.
-- ------------------------------------------------------------
CREATE TABLE applications (
  application_id  TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','reviewing','interview','offer','rejected','withdrawn')),
  applied_date    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, job_id),
  FOREIGN KEY (student_id) REFERENCES students (student_id)     ON DELETE CASCADE,
  FOREIGN KEY (job_id)     REFERENCES job_postings (job_id)     ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- users — login accounts. This table is NOT in the original ER
-- diagram: the diagram models the domain, but a real app needs
-- somewhere to keep credentials. One account maps to exactly one
-- profile row, and the CHECK below enforces that the profile
-- column matches the account's role.
--
-- password_hash holds a bcrypt digest. Plaintext passwords are
-- never stored, logged, or returned by the API.
-- ------------------------------------------------------------
CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('student', 'employer', 'admin')),
  student_id     TEXT UNIQUE,
  employer_id    TEXT UNIQUE,
  admin_id       TEXT UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
       (role = 'student'  AND student_id  IS NOT NULL AND employer_id IS NULL AND admin_id    IS NULL)
    OR (role = 'employer' AND employer_id IS NOT NULL AND student_id  IS NULL AND admin_id    IS NULL)
    OR (role = 'admin'    AND admin_id    IS NOT NULL AND student_id  IS NULL AND employer_id IS NULL)
  ),
  FOREIGN KEY (student_id)  REFERENCES students  (student_id)  ON DELETE CASCADE,
  FOREIGN KEY (employer_id) REFERENCES employers (employer_id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id)    REFERENCES admins    (admin_id)    ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- sessions — one row per sign-in.
--
-- A JWT on its own cannot be taken back: it is valid until it
-- expires, so "sign out" would only delete the copy in the
-- browser. The token now carries a session id that is checked
-- against this table on every request, which is what makes
-- signing out — and signing out everywhere — actually revoke.
-- ------------------------------------------------------------
CREATE TABLE sessions (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  user_agent  TEXT,
  FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- resumes — an uploaded resume and what the scan made of it.
-- Also not on the original ER diagram; it hangs off students.
--
-- We keep the EXTRACTED TEXT, never the original file: the text is
-- all the matcher needs, and storing uploaded binaries would mean
-- managing a file store and a much larger privacy surface.
-- `engine` records whether a model or the offline keyword matcher
-- produced the analysis, so the UI can never pass one off as the other.
-- ------------------------------------------------------------
CREATE TABLE resumes (
  resume_id    TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  char_count   INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,
  engine       TEXT CHECK (engine IN ('ai', 'keyword')),
  model        TEXT,
  analyzed_at  TEXT,
  analysis     TEXT CHECK (analysis IS NULL OR json_valid(analysis)),
  FOREIGN KEY (student_id) REFERENCES students (student_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- Indexes for the joins the app actually runs.
-- ------------------------------------------------------------
CREATE INDEX idx_users_role      ON users (role);
CREATE INDEX idx_sessions_user   ON sessions (user_id);
CREATE INDEX idx_programs_trade  ON programs (trade);
CREATE INDEX idx_jobs_employer   ON job_postings (employer_id);
CREATE INDEX idx_jobs_status     ON job_postings (status);
CREATE INDEX idx_jobs_source     ON job_postings (source);
CREATE INDEX idx_apps_student    ON applications (student_id);
CREATE INDEX idx_apps_job        ON applications (job_id);
CREATE INDEX idx_quiz_student    ON quiz_results (student_id);

-- ------------------------------------------------------------
-- The student-facing job board.
--
-- Employer-posted jobs appear only if approved AND the employer
-- is verified. Imported jobs were already public elsewhere, so
-- they appear on their own terms and carry their own company and
-- coordinates. Putting this in one view means the board and the
-- "can this student apply" check can never disagree.
-- ------------------------------------------------------------
CREATE VIEW open_jobs AS
SELECT j.job_id, j.title, j.wage_range, j.status, j.source, j.source_url,
       j.employer_id,
       COALESCE(e.company_name, j.company_name) AS company_name,
       COALESCE(e.industry, 'Imported listing')  AS industry,
       COALESCE(e.location, j.location)          AS location,
       COALESCE(e.latitude, j.latitude)          AS latitude,
       COALESCE(e.longitude, j.longitude)        AS longitude
FROM job_postings j
LEFT JOIN employers e ON e.employer_id = j.employer_id
WHERE (j.source = 'employer' AND j.status = 'approved' AND e.verified = 1)
   OR (j.source <> 'employer');
