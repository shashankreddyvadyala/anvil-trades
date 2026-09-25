import { useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Panel, Table, Tag, Stat, Stats, Field, Bar, Distance, ErrorNote,
         requestBrowserLocation, usd, fmtDate, useAsync } from "../ui.jsx";
import Resume from "./Resume.jsx";

export default function Student({ page, navigate, toast }) {
  switch (page) {
    case "quiz":     return <Quiz toast={toast} navigate={navigate} />;
    case "resume":   return <Resume toast={toast} navigate={navigate} />;
    case "programs": return <Programs navigate={navigate} />;
    case "jobs":     return <Jobs toast={toast} />;
    case "apps":     return <Applications toast={toast} />;
    case "profile":  return <Profile toast={toast} />;
    default:         return <Dashboard navigate={navigate} />;
  }
}

/**
 * "Use my location" — asks the browser, stores the fix on the profile, and
 * tells the parent to refetch so distances reflect where the viewer actually
 * is rather than the town they typed at signup.
 */
function LocationBar({ onUpdated }) {
  const { profile, refreshProfile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  async function locate() {
    setBusy(true); setNote(null);
    const fix = await requestBrowserLocation();
    if (fix.error) { setNote(fix.error); setBusy(false); return; }
    try {
      refreshProfile(await api.setStudentLocation(profile.student_id, fix.latitude, fix.longitude));
      setNote("Using your current location.");
      onUpdated?.();
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="geobar">
      <span>
        Distances measured from <b>{profile.location}</b>
        {profile.latitude == null && " — no coordinates on file yet"}
      </span>
      <span className="spacer" />
      {note && <span className="note">{note}</span>}
      <button className="btn sm" onClick={locate} disabled={busy}>
        {busy ? "Locating…" : "Use my location"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Dashboard({ navigate }) {
  const { profile } = useAuth();
  const quiz = useAsync(() => api.myQuiz(), []);
  const apps = useAsync(() => api.applications(), []);
  const jobs = useAsync(() => api.jobs({}), []);
  const resume = useAsync(() => api.myResume(), []);

  if (quiz.loading || apps.loading) return <p className="empty">Loading…</p>;

  const matches = quiz.data?.matches?.slice(0, 3) || [];
  const open = (apps.data || []).filter(a => ["submitted", "reviewing", "interview", "offer"].includes(a.status));
  const analysis = resume.data?.analysis;

  return (
    <>
      <Stats>
        <Stat value={matches[0]?.trade || "—"} label="Top match" />
        <Stat value={open.length} label="Active applications" />
        <Stat value={jobs.data?.length ?? "—"} label="Open jobs" />
        <Stat value={resume.data ? (analysis ? "Scanned" : "Uploaded") : "Not uploaded"} label="Resume" />
      </Stats>

      <Panel
        title="From your resume"
        action={<button className={"btn sm " + (analysis ? "" : "primary")} onClick={() => navigate("resume")}>
          {analysis ? "Open" : "Upload resume"}
        </button>}>
        {analysis ? (
          <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className={"engine " + (resume.data.engine === "ai" ? "ai" : "local")} style={{ alignSelf: "flex-start" }}>
              {resume.data.engine === "ai" ? "Scanned by Claude" : "Offline keyword match"}
            </span>
            <p>{analysis.summary}</p>
            {analysis.skills.length > 0 && (
              <div className="chips">
                {analysis.skills.slice(0, 8).map(s => <span className="chip2 hit" key={s}>{s}</span>)}
              </div>
            )}
          </div>
        ) : (
          <p className="empty">
            No resume scanned yet. Upload one and it gets matched against every program and open job.
          </p>
        )}
      </Panel>

      <div className="cols">
        <Panel title="Your profile"
               action={<button className="btn sm" onClick={() => navigate("profile")}>Edit</button>}>
          <div className="pad">
            <dl className="kv">
              <dt>student_id</dt><dd className="id">{profile.student_id}</dd>
              <dt>Name</dt><dd>{profile.name}</dd>
              <dt>School</dt><dd>{profile.school}</dd>
              <dt>Grad year</dt><dd>{profile.grad_year}</dd>
              <dt>Location</dt><dd>{profile.location}</dd>
            </dl>
          </div>
        </Panel>

        <Panel title="Your top trades"
               action={<button className="btn sm" onClick={() => navigate("quiz")}>
                 {quiz.data ? "Retake quiz" : "Take quiz"}</button>}>
          {matches.length ? matches.map((m, i) => (
            <div className="match" key={m.trade}>
              <span className="rank">{i + 1}</span>
              <div className="match-main">
                <div className="strong">{m.trade}</div>
                <div className="sub">{m.program_count} program{m.program_count === 1 ? "" : "s"}</div>
                <Bar pct={m.pct} />
              </div>
              <div className="match-fig">{usd(m.top_wage)}<div className="sub">top start</div></div>
              <button className="btn sm" onClick={() => navigate("programs", m.trade)}>Programs</button>
            </div>
          )) : <p className="empty">Take the six-question quiz to get matched.</p>}
        </Panel>
      </div>

      <Panel title="Recent applications"
             action={<button className="btn sm" onClick={() => navigate("apps")}>See all</button>}>
        <Table
          columns={[{ label: "Posting" }, { label: "Status" }, { label: "Applied", num: true }]}
          empty="You haven't applied to anything yet."
          rows={(apps.data || []).slice(0, 5).map(a => (
            <tr key={a.application_id}>
              <td><span className="strong">{a.title}</span><div className="sub">{a.company_name}</div></td>
              <td><Tag>{a.status}</Tag></td>
              <td className="num">{fmtDate(a.applied_date)}</td>
            </tr>
          ))} />
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Profile({ toast }) {
  const { profile, refreshProfile } = useAuth();
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      refreshProfile(await api.updateStudent(profile.student_id, { ...f, grad_year: Number(f.grad_year) }));
      toast("Profile saved");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Panel title={`Student record — ${profile.student_id}`}>
      <form className="pad" onSubmit={save}>
        <div className="formgrid">
          <Field label="Full name"><input name="name" id="p-name" defaultValue={profile.name} required /></Field>
          <Field label="High school"><input name="school" id="p-school" defaultValue={profile.school} required /></Field>
          <Field label="Graduation year">
            <input name="grad_year" id="p-grad" type="number" defaultValue={profile.grad_year} required />
          </Field>
          <Field label="City and state"><input name="location" id="p-loc" defaultValue={profile.location} required /></Field>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="row-between" style={{ marginTop: 14 }}>
          <span className="note">Employers see your name, school and graduation year when you apply.</span>
          <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */

function Quiz({ toast, navigate }) {
  const questions = useAsync(() => api.quizQuestions(), []);
  const mine = useAsync(() => api.myQuiz(), []);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (questions.loading || mine.loading) return <p className="empty">Loading…</p>;

  const list = questions.data.questions;
  const prior = mine.data?.answers || [];
  const matches = result?.matches || mine.data?.matches || null;

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    const f = new FormData(e.currentTarget);
    const answers = list.map((_, i) => Number(f.get(`q${i}`)));
    try {
      setResult(await api.submitQuiz(answers));
      toast("Quiz scored");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Panel title="Questions">
        <form onSubmit={submit}>
          {list.map((item, qi) => (
            <div className="quiz-q" key={qi}>
              <p><span className="qnum">{String(qi + 1).padStart(2, "0")}</span>{item.q}</p>
              <div className="opts">
                {item.opts.map((o, oi) => (
                  <label className="opt" key={oi}>
                    <input type="radio" name={`q${qi}`} value={oi} required defaultChecked={prior[qi] === oi} />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="pad">
            <ErrorNote>{error}</ErrorNote>
            <div className="row-between">
              <span className="note">Saved as one row in <code>quiz_results</code>; scoring runs on the server.</span>
              <button className="btn primary" disabled={busy}>
                {busy ? "Scoring…" : mine.data ? "Save & re-score" : "Submit quiz"}
              </button>
            </div>
          </div>
        </form>
      </Panel>

      {matches && (
        <Panel title="Scored trades">
          {matches.map((m, i) => (
            <div className="match" key={m.trade}>
              <span className="rank">{i + 1}</span>
              <div className="match-main">
                <div className="strong">{m.trade}</div>
                <div className="sub">
                  {m.program_count} program{m.program_count === 1 ? "" : "s"} · from {usd(m.low_cost)} ·
                  {" "}top start {usd(m.top_wage)}
                </div>
                <Bar pct={m.pct} />
              </div>
              <div className="match-fig">{m.score}<div className="sub">pts</div></div>
              <button className="btn sm" onClick={() => navigate("programs", m.trade)}>Programs</button>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Programs({ navigate }) {
  // A trade passed through navigation pre-filters the table.
  const [filters, setFilters] = useState({ trade: navigate.param || "", search: "", sort: "cost" });
  const [nonce, setNonce] = useState(0);
  const trades = useAsync(() => api.trades(), []);
  const programs = useAsync(() => api.programs(filters), [filters.trade, filters.search, filters.sort, nonce]);

  function apply(e) {
    e.preventDefault();
    setFilters(Object.fromEntries(new FormData(e.currentTarget).entries()));
  }

  const rows = programs.data || [];
  const cheapest = [...rows].sort((a, b) => a.cost - b.cost)[0];
  const best = [...rows].sort((a, b) => b.avg_starting_wage - a.avg_starting_wage)[0];

  const nearest = rows.filter(r => r.distance_miles != null)
    .sort((a, b) => a.distance_miles - b.distance_miles)[0];

  return (
    <>
      {rows.length > 0 && (
        <Stats>
          <Stat value={rows.length} label={filters.trade ? `Programs in ${filters.trade}` : "Programs shown"} />
          <Stat value={usd(cheapest.cost)} label="Cheapest" />
          <Stat value={usd(best.avg_starting_wage)} label="Highest avg start" />
          <Stat value={nearest ? `${nearest.distance_miles} mi` : "—"} label="Nearest to you" />
        </Stats>
      )}

      <LocationBar onUpdated={() => setNonce(n => n + 1)} />

      <Panel title="Filter">
        <form className="pad filters" onSubmit={apply} key={filters.trade}>
          <Field label="Search provider, city or trade" className="grow">
            <input name="search" id="f-search" defaultValue={filters.search} placeholder="e.g. Durham" />
          </Field>
          <Field label="Trade">
            <select name="trade" id="f-trade" defaultValue={filters.trade}>
              <option value="">All trades</option>
              {(trades.data || []).map(t => <option key={t.trade} value={t.trade}>{t.trade}</option>)}
            </select>
          </Field>
          <Field label="Sort by">
            <select name="sort" id="f-sort" defaultValue={filters.sort}>
              <option value="cost">Cost, low to high</option>
              <option value="wage">Starting wage, high to low</option>
              <option value="payback">Debt vs. pay, best first</option>
              <option value="distance">Distance from you</option>
              <option value="name">Provider name</option>
            </select>
          </Field>
          <button className="btn">Apply</button>
          <button className="btn" type="button"
                  onClick={() => setFilters({ trade: "", search: "", sort: "cost" })}>Clear</button>
        </form>
      </Panel>

      <Panel title={`${rows.length} programs`}>
        <Table
          columns={[{ label: "Provider" }, { label: "Trade" }, { label: "Location" }, { label: "Distance", num: true },
                    { label: "Time to certify" }, { label: "Cost", num: true }, { label: "Avg start", num: true },
                    { label: "Avg debt", num: true }, { label: "Source" }]}
          empty="No programs match those filters."
          rows={rows.map(p => (
            <tr key={p.program_id}>
              <td><span className="strong">{p.provider_name}</span><div className="id">{p.program_id}</div></td>
              <td>{p.trade}</td>
              <td>{p.location}</td>
              <td className="num">{p.distance_miles == null ? "—" : `${p.distance_miles} mi`}</td>
              <td>{p.time_to_certify}</td>
              <td className="num">{usd(p.cost)}</td>
              <td className="num">{usd(p.avg_starting_wage)}</td>
              <td className="num">{usd(p.avg_debt)}</td>
              <td className="sub">{p.data_source}</td>
            </tr>
          ))} />
      </Panel>

      <p className="note">
        Cost is what the provider charges; average starting wage and average debt describe that program's
        recent graduates, sourced per row. All figures are demo values modeled on public occupational
        data — placeholders for a real feed, not live statistics.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Jobs({ toast }) {
  const [filters, setFilters] = useState({ search: "", source: "", sort: "" });
  const [nonce, setNonce] = useState(0);
  const jobs = useAsync(() => api.jobs(filters), [filters.search, filters.source, filters.sort, nonce]);
  const apps = useAsync(() => api.applications(), []);
  const [error, setError] = useState(null);

  const appliedTo = Object.fromEntries((apps.data || []).map(a => [a.job_id, a]));

  async function apply(job_id) {
    setError(null);
    try {
      await api.apply(job_id);
      toast("Application submitted");
      apps.reload();
    } catch (err) { setError(err.message); }
  }

  const rows = jobs.data || [];

  return (
    <>
      <LocationBar onUpdated={() => setNonce(n => n + 1)} />

      <Panel title="Filter">
        <form className="pad filters"
              onSubmit={e => { e.preventDefault(); setFilters(Object.fromEntries(new FormData(e.currentTarget).entries())); }}>
          <Field label="Search title or company" className="grow">
            <input name="search" id="j-search" defaultValue={filters.search} placeholder="e.g. electrician" />
          </Field>
          <Field label="Listing type">
            <select name="source" id="j-source" defaultValue={filters.source}>
              <option value="">All listings</option>
              <option value="employer">Employers on Anvil</option>
              <option value="adzuna">Imported — Adzuna</option>
              <option value="careeronestop">Imported — CareerOneStop</option>
            </select>
          </Field>
          <Field label="Sort by">
            <select name="sort" id="j-sort" defaultValue={filters.sort}>
              <option value="">Company name</option>
              <option value="distance">Distance from you</option>
            </select>
          </Field>
          <button className="btn">Search</button>
        </form>
      </Panel>

      <ErrorNote>{error}</ErrorNote>

      <Panel title={`${rows.length} open postings`}>
        <Table
          columns={[{ label: "Title" }, { label: "Employer" }, { label: "Location" },
                    { label: "Distance", num: true }, { label: "Wage range", num: true }, { label: "" }]}
          empty="No open postings match that search."
          rows={rows.map(j => (
            <tr key={j.job_id}>
              <td>
                <span className="strong">{j.title}</span>
                <div className="id">{j.job_id}{j.source !== "employer" && <> · <span className="imported">imported</span></>}</div>
              </td>
              <td>{j.company_name}<div className="sub">{j.industry}</div></td>
              <td>{j.location}</td>
              <td className="num">{j.distance_miles == null ? "—" : `${j.distance_miles} mi`}</td>
              <td className="num">{j.wage_range}</td>
              <td>
                {/* An imported listing has no employer account here to receive
                    an application, so it links out instead of offering Apply. */}
                {j.source !== "employer"
                  ? <a className="outlink" href={j.source_url} target="_blank" rel="noopener noreferrer">Apply on their site</a>
                  : appliedTo[j.job_id]
                    ? <Tag>{appliedTo[j.job_id].status}</Tag>
                    : <button className="btn sm primary" onClick={() => apply(j.job_id)}>Apply</button>}
              </td>
            </tr>
          ))} />
      </Panel>

      <p className="note">
        Listings marked <span className="imported">imported</span> come from an outside job board. Anvil has no
        account for those employers, so applying happens on their own site — an application sent here would have
        nobody to receive it.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** Stages a student can still step out of. After a rejection there's nothing to withdraw. */
const WITHDRAWABLE = ["submitted", "reviewing", "interview", "offer"];

function Applications({ toast }) {
  const apps = useAsync(() => api.applications(), []);
  const [error, setError] = useState(null);

  async function withdraw(a) {
    if (!window.confirm(`Withdraw your application for "${a.title}"? You can't apply to this posting again afterwards.`)) return;
    setError(null);
    try {
      await api.setApplicationStatus(a.application_id, "withdrawn");
      toast(`Withdrew ${a.application_id}`);
      apps.reload();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
    <ErrorNote>{error}</ErrorNote>
    <Panel title="Applications">
      <Table
        columns={[{ label: "ID" }, { label: "Posting" }, { label: "Employer" }, { label: "Wage", num: true },
                  { label: "Status" }, { label: "Applied", num: true }, { label: "" }]}
        empty="You haven't applied to anything yet."
        rows={(apps.data || []).map(a => (
          <tr key={a.application_id}>
            <td className="id">{a.application_id}</td>
            <td><span className="strong">{a.title}</span></td>
            <td>{a.company_name}</td>
            <td className="num">{a.wage_range}</td>
            <td><Tag>{a.status}</Tag></td>
            <td className="num">{fmtDate(a.applied_date)}</td>
            <td>{WITHDRAWABLE.includes(a.status) &&
              <button className="btn sm danger" onClick={() => withdraw(a)}>Withdraw</button>}</td>
          </tr>
        ))} />
    </Panel>
    </>
  );
}
