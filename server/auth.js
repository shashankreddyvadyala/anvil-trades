/**
 * Authentication: password hashing, revocable sessions, and the middleware
 * the API routes use to guard themselves.
 *
 * Rules the rest of the app relies on:
 *   - Passwords are bcrypt-hashed. Plaintext is never stored or returned.
 *   - A token carries ids, a role and a SESSION ID — never a password hash.
 *   - Every request re-checks that session row, which is what makes signing
 *     out actually revoke. A bare JWT cannot be taken back: it stays valid
 *     until it expires, so "sign out" would otherwise only delete the copy in
 *     the browser while a stolen one kept working for a week.
 *   - The token travels ONLY in an httpOnly cookie. Page scripts can't read
 *     it, so an injected script can't steal it, and the API never puts it in
 *     a response body. The cookie is SameSite=Lax, so another website can't
 *     make signed-in POST/PATCH/DELETE requests with it either.
 *   - `requireRole` checks the role; `ownsStudent`/`ownsEmployer` check that
 *     the caller owns the specific row they're touching, so a signed-in
 *     employer can't edit another company's postings.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { get, run, nowStamp } from "./db.js";

const PRODUCTION = process.env.NODE_ENV === "production";

/**
 * The signing key for every session token.
 *
 * A deployment that shipped with the development fallback would be signing
 * tokens with a secret published in this repo — anyone could forge an admin
 * token. So in production a missing JWT_SECRET stops the server at boot
 * rather than quietly running insecure.
 */
export const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (PRODUCTION) {
    console.error(
      "\nJWT_SECRET is not set.\n" +
      "Set it to a long random string in your host's environment variables.\n" +
      "Generate one with:  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n"
    );
    process.exit(1);
  }
  return "dev-only-secret-change-me";
})();

export const SESSION_DAYS = 7;
export const COOKIE_NAME = "anvil_session";
const BCRYPT_ROUNDS = 10;

export const hashPassword = pw => bcrypt.hashSync(pw, BCRYPT_ROUNDS);
export const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

/** Minimum password policy. Returns an error string, or null if OK. */
export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 72) return "Password must be 72 characters or fewer.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must include a letter and a number.";
  return null;
}

export function emailProblem(email) {
  if (typeof email !== "string" || email.trim().length > 254
      || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
    return "Enter a valid email address.";
  }
  return null;
}

/** Strip the hash before any user object leaves the server. */
export function publicUser(user) {
  const { password_hash, ...safe } = user;
  return safe;
}

/* ============================================================
   SESSIONS
   ============================================================ */

/** Open a session row and mint the token that points at it. */
export async function startSession(user, req) {
  const session_id = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);

  await run(
    "INSERT INTO sessions (session_id, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)",
    session_id, user.user_id, nowStamp(),
    expires.toISOString().slice(0, 19).replace("T", " "),
    String(req?.headers?.["user-agent"] || "").slice(0, 200)
  );

  const token = jwt.sign(
    {
      sid: session_id,
      user_id: user.user_id,
      role: user.role,
      student_id: user.student_id,
      employer_id: user.employer_id,
      admin_id: user.admin_id
    },
    JWT_SECRET,
    { expiresIn: `${SESSION_DAYS}d` }
  );

  return { token, session_id, expires };
}

export async function revokeSession(session_id) {
  await run("UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
            nowStamp(), session_id);
}

export async function revokeAllSessions(user_id) {
  const res = await run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                        nowStamp(), user_id);
  return res.changes;
}

/** Cookie options. Secure only in production, or a local http:// login breaks. */
export function cookieOptions(expires) {
  return {
    httpOnly: true,
    secure: PRODUCTION,
    sameSite: "lax",
    path: "/",
    ...(expires ? { expires } : {})
  };
}

/* ============================================================
   MIDDLEWARE
   ============================================================ */

/** Populates req.user when a valid, unrevoked session is presented. Never rejects. */
export async function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];

  if (token) {
    try {
      const claims = jwt.verify(token, JWT_SECRET);

      // The signature only proves the token was minted here. Whether it is
      // still good is a question about the session row.
      const session = await get(
        "SELECT * FROM sessions WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ?",
        claims.sid, nowStamp()
      );

      if (session) {
        const row = await get("SELECT * FROM users WHERE user_id = ?", claims.user_id);
        if (row) {
          req.user = publicUser(row);
          req.sessionId = claims.sid;
        }
      }
    } catch {
      /* expired or tampered token — treated as signed out */
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  next();
}

/** requireRole("employer") or requireRole("employer", "admin") */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Sign in to continue." });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: `This action is for ${roles.join(" or ")} accounts.` });
  }
  next();
};

/** The signed-in employer must own `employerId`; admins may act on any. */
export function ownsEmployer(req, employerId) {
  if (req.user.role === "admin") return true;
  return req.user.role === "employer" && req.user.employer_id === employerId;
}

/**
 * The signed-in student must be `studentId`. Used for WRITES, so admins do
 * NOT pass: the admin roster is read-only, and a student's profile is theirs
 * alone to change — it's what employers see when they apply.
 */
export function ownsStudent(req, studentId) {
  return req.user.role === "student" && req.user.student_id === studentId;
}
