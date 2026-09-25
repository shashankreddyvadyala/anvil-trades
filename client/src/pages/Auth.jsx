import { useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Field, ErrorNote, useAsync } from "../ui.jsx";

const MODES = {
  login: { heading: "Sign in", cta: "Sign in" },
  student: { heading: "Create a student account", cta: "Create account" },
  employer: { heading: "Create an employer account", cta: "Create account" }
};

const DEMO = [
  { role: "Student", email: "jordan.ellis@student.test" },
  { role: "Employer", email: "hiring@carolinacurrentelectric.test" },
  { role: "Admin", email: "renee.alvarado@anvil.test" }
];

/**
 * The whole signed-out experience: sign in, or create a student or
 * employer profile. Client-side checks mirror the server's rules so the
 * common mistakes are caught before a round trip — the server still
 * validates everything again.
 */
export default function Auth() {
  const { login, signupStudent, signupEmployer } = useAuth();
  const [mode, setMode] = useState("login");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // On your own computer the server shares the demo password so the box below
  // can show it. A public site never does (it comes back null).
  const config = useAsync(() => api.config(), []);
  const demoPassword = config.data?.demo_password;

  const thisYear = new Date().getFullYear();

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());

    if (mode !== "login") {
      if (f.password.length < 8 || !/[a-zA-Z]/.test(f.password) || !/[0-9]/.test(f.password)) {
        return setError("Password must be at least 8 characters and include a letter and a number.");
      }
      if (f.password !== f.confirm) return setError("The two passwords don't match.");
    }

    setBusy(true);
    try {
      if (mode === "login") await login({ email: f.email, password: f.password });
      else if (mode === "student") await signupStudent({ ...f, grad_year: Number(f.grad_year) });
      else await signupEmployer(f);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next) { setMode(next); setError(null); }

  return (
    <div className="auth">
      <aside className="auth-aside">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-name">Anvil</div>
            <div className="brand-sub">Trades Portal</div>
          </div>
        </div>
        <h2>Paid work, not guesswork.</h2>
        <p>
          Anvil matches high-school students to skilled-trade training using real
          starting wages and training costs, then connects them to verified local
          employers who are hiring apprentices.
        </p>
        <dl className="auth-facts">
          <div><dt>Students</dt><dd>Scan a resume, compare programs by cost and pay, apply to jobs.</dd></div>
          <div><dt>Employers</dt><dd>Post apprentice roles and manage applicants.</dd></div>
          <div><dt>Admins</dt><dd>Verify companies and review postings before students see them.</dd></div>
        </dl>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-switch" role="tablist" aria-label="Account action">
            <button type="button" role="tab" aria-selected={mode === "login"}
                    onClick={() => switchMode("login")}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === "student"}
                    onClick={() => switchMode("student")}>I'm a student</button>
            <button type="button" role="tab" aria-selected={mode === "employer"}
                    onClick={() => switchMode("employer")}>I'm an employer</button>
          </div>

          <h1>{MODES[mode].heading}</h1>
          <p className="auth-lede">
            {mode === "login" && "Use the email and password for your Anvil account."}
            {mode === "student" && "This creates your student profile and your login in one step."}
            {mode === "employer" && "New companies start unverified — an admin reviews you before your jobs go live."}
          </p>

          <form onSubmit={onSubmit} key={mode}>
            {mode === "student" && (
              <>
                <Field label="Full name">
                  <input name="name" id="su-name" required autoComplete="name" placeholder="Jordan Ellis" />
                </Field>
                <div className="formgrid">
                  <Field label="High school">
                    <input name="school" id="su-school" required placeholder="Apex Friendship High School" />
                  </Field>
                  <Field label="Graduation year">
                    <input name="grad_year" id="su-grad" type="number" required
                           min={thisYear - 2} max={thisYear + 8} defaultValue={thisYear + 1} />
                  </Field>
                </div>
                <Field label="City and state" hint="Or a ZIP code. Used to show how far programs and jobs are.">
                  <input name="location" id="su-loc" required placeholder="Apex, NC" />
                </Field>
              </>
            )}

            {mode === "employer" && (
              <>
                <Field label="Company name">
                  <input name="company_name" id="su-co" required autoComplete="organization"
                         placeholder="Carolina Current Electric" />
                </Field>
                <div className="formgrid">
                  <Field label="Industry">
                    <input name="industry" id="su-ind" required placeholder="Electrical Contracting" />
                  </Field>
                  <Field label="City and state">
                    <input name="location" id="su-eloc" required placeholder="Raleigh, NC" />
                  </Field>
                </div>
              </>
            )}

            <Field label="Email">
              <input name="email" id="au-email" type="email" required autoComplete="email"
                     placeholder="you@example.com" />
            </Field>

            <Field
              label="Password"
              hint={mode !== "login" ? "At least 8 characters, with a letter and a number." : null}>
              <input name="password" id="au-pw" type="password" required
                     autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </Field>

            {mode !== "login" && (
              <Field label="Confirm password">
                <input name="confirm" id="au-pw2" type="password" required autoComplete="new-password" />
              </Field>
            )}

            <ErrorNote>{error}</ErrorNote>

            <button className="btn primary block" type="submit" disabled={busy}>
              {busy ? "Working…" : MODES[mode].cta}
            </button>
          </form>

          {mode === "login" ? (
            <p className="auth-alt">
              No account yet?{" "}
              <button type="button" className="linkbtn" onClick={() => switchMode("student")}>Sign up as a student</button>
              {" or "}
              <button type="button" className="linkbtn" onClick={() => switchMode("employer")}>as an employer</button>.
            </p>
          ) : (
            <p className="auth-alt">
              Already have an account?{" "}
              <button type="button" className="linkbtn" onClick={() => switchMode("login")}>Sign in</button>.
            </p>
          )}

          <div className="demo-box">
            <span className="lbl">
              Demo accounts — {demoPassword
                ? <>password <code>{demoPassword}</code></>
                : "ask the site owner for the password"}
            </span>
            <ul>
              {DEMO.map(d => (
                <li key={d.email}>
                  <span>{d.role}</span>
                  <code>{d.email}</code>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
