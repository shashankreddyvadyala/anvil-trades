import { useState } from "react";
import { api } from "../api.js";
import { Panel, Table, Tag, Stat, Stats, Field, ErrorNote, usd, fmtDate, useAsync } from "../ui.jsx";

export default function Admin({ page, navigate, toast }) {
  switch (page) {
    case "moderation": return <Moderation toast={toast} />;
    case "employers":  return <Employers toast={toast} />;
    case "students":   return <Students />;
    case "programs":   return <Programs />;
    case "feeds":      return <Feeds toast={toast} />;
    default:           return <Overview navigate={navigate} toast={toast} />;
  }
}

/* ------------------------------------------------------------------ */

function Overview({ navigate, toast }) {
  const stats = useAsync(() => api.stats(), []);
  const pending = useAsync(() => api.postings({ status: "pending" }), []);
  const [error, setError] = useState(null);

  async function decide(id, decision) {
    setError(null);
    try {
      await api.moderate(id, decision);
      toast(`${id} ${decision}`);
      pending.reload();
      stats.reload();
    } catch (err) { setError(err.message); }
  }

  const s = stats.data;
  return (
    <>
      <Stats>
        <Stat value={s?.students ?? "—"} label="Students" />
        <Stat value={s?.quizzes ?? "—"} label="Quizzes taken" />
        <Stat value={s?.employers ?? "—"} label="Employers" />
        <Stat value={s?.pending_reviews ?? "—"} label="Awaiting review" />
        <Stat value={s?.unverified ?? "—"} label="Unverified companies" />
        <Stat value={s?.applications ?? "—"} label="Applications" />
        <Stat value={s?.imported_jobs ?? "—"} label="Imported listings" />
      </Stats>

      <ErrorNote>{error}</ErrorNote>

      <Panel title="Postings awaiting review"
             action={<button className="btn sm" onClick={() => navigate("moderation")}>Full queue</button>}>
        <Table
          columns={[{ label: "Posting" }, { label: "Employer" }, { label: "Wage", num: true }, { label: "" }]}
          empty="The queue is clear."
          rows={(pending.data || []).map(j => (
            <tr key={j.job_id}>
              <td><span className="strong">{j.title}</span><div className="id">{j.job_id}</div></td>
              <td>{j.company_name} {j.verified ? <Tag>verified</Tag> : <Tag>unverified</Tag>}</td>
              <td className="num">{j.wage_range}</td>
              <td>
                <div className="btnrow">
                  <button className="btn sm primary" onClick={() => decide(j.job_id, "approved")}>Approve</button>
                  <button className="btn sm danger" onClick={() => decide(j.job_id, "rejected")}>Reject</button>
                </div>
              </td>
            </tr>
          ))} />
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Moderation({ toast }) {
  const [status, setStatus] = useState("pending");
  const postings = useAsync(() => api.postings({ status }), [status]);
  const [error, setError] = useState(null);

  async function decide(id, decision) {
    setError(null);
    try {
      await api.moderate(id, decision);
      toast(`${id} ${decision}`);
      postings.reload();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <Panel title="Filter">
        <form className="pad filters" onSubmit={e => { e.preventDefault(); setStatus(new FormData(e.currentTarget).get("status")); }}>
          <Field label="Review status">
            <select name="status" id="m-status" defaultValue={status}>
              <option value="">All statuses</option>
              <option value="pending">pending</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
            </select>
          </Field>
          <button className="btn">Apply</button>
        </form>
      </Panel>

      <ErrorNote>{error}</ErrorNote>

      <Panel title={`${postings.data?.length ?? 0} postings`}>
        <Table
          columns={[{ label: "Posting" }, { label: "Employer" }, { label: "Wage", num: true },
                    { label: "Status" }, { label: "Decision" }]}
          rows={(postings.data || []).map(j => (
            <tr key={j.job_id}>
              <td><span className="strong">{j.title}</span><div className="id">{j.job_id}</div></td>
              <td>{j.company_name} {j.verified ? <Tag>verified</Tag> : <Tag>unverified</Tag>}</td>
              <td className="num">{j.wage_range}</td>
              <td><Tag>{j.status}</Tag></td>
              <td>
                <div className="btnrow">
                  <button className="btn sm primary" disabled={j.status === "approved"}
                          onClick={() => decide(j.job_id, "approved")}>Approve</button>
                  <button className="btn sm danger" disabled={j.status === "rejected"}
                          onClick={() => decide(j.job_id, "rejected")}>Reject</button>
                </div>
              </td>
            </tr>
          ))} />
      </Panel>

      <p className="note">
        Approving sets <code>job_postings.status</code> to <code>approved</code> and stamps your{" "}
        <code>admin_id</code> on the row. Students still won't see it unless the employer is verified.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Employers({ toast }) {
  const employers = useAsync(() => api.employers(), []);
  const [error, setError] = useState(null);

  async function toggle(e) {
    setError(null);
    try {
      await api.setVerification(e.employer_id, !e.verified);
      toast(`${e.company_name} ${e.verified ? "verification revoked" : "verified"}`);
      employers.reload();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <ErrorNote>{error}</ErrorNote>
      <Panel title="All employers">
        <Table
          columns={[{ label: "Company" }, { label: "Industry" }, { label: "Location" },
                    { label: "Postings", num: true }, { label: "Verification" }, { label: "" }]}
          rows={(employers.data || []).map(e => (
            <tr key={e.employer_id}>
              <td><span className="strong">{e.company_name}</span><div className="id">{e.employer_id}</div></td>
              <td>{e.industry}</td>
              <td>{e.location}</td>
              <td className="num">{e.posting_count}</td>
              <td><Tag>{e.verified ? "verified" : "unverified"}</Tag></td>
              <td>
                <button className={"btn sm " + (e.verified ? "danger" : "primary")} onClick={() => toggle(e)}>
                  {e.verified ? "Revoke" : "Verify"}
                </button>
              </td>
            </tr>
          ))} />
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Students() {
  const students = useAsync(() => api.students(), []);
  return (
    <>
      <Panel title="Roster">
        <Table
          columns={[{ label: "Student" }, { label: "Email" }, { label: "School" }, { label: "Grad", num: true },
                    { label: "Quiz" }, { label: "Apps", num: true }]}
          rows={(students.data || []).map(s => (
            <tr key={s.student_id}>
              <td><span className="strong">{s.name}</span><div className="id">{s.student_id}</div></td>
              <td className="sub">{s.email || "—"}</td>
              <td>{s.school}</td>
              <td className="num">{s.grad_year}</td>
              <td>{s.quiz_count ? <Tag>complete</Tag> : <Tag tone="warn">not taken</Tag>}</td>
              <td className="num">{s.application_count}</td>
            </tr>
          ))} />
      </Panel>
      <p className="note">Admins read student records; they cannot edit them or see quiz answers.</p>
    </>
  );
}

function Programs() {
  const programs = useAsync(() => api.programs({ sort: "wage" }), []);
  return (
    <>
      <Panel title="programs">
        <Table
          columns={[{ label: "Provider" }, { label: "Trade" }, { label: "Location" }, { label: "Time to certify" },
                    { label: "Cost", num: true }, { label: "Avg start", num: true }, { label: "Avg debt", num: true },
                    { label: "Data source" }]}
          rows={(programs.data || []).map(p => (
            <tr key={p.program_id}>
              <td><span className="strong">{p.provider_name}</span><div className="id">{p.program_id}</div></td>
              <td>{p.trade}</td>
              <td>{p.location}</td>
              <td>{p.time_to_certify}</td>
              <td className="num">{usd(p.cost)}</td>
              <td className="num">{usd(p.avg_starting_wage)}</td>
              <td className="num">{usd(p.avg_debt)}</td>
              <td className="sub">{p.data_source}</td>
            </tr>
          ))} />
      </Panel>
      <p className="note">
        Outcome figures sit on the program, not on a shared trade record — two providers teaching the
        same trade report different wages and different debt, and a student comparing them needs to see that.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The job feed. Imported listings sit alongside employer-posted ones on the
 * board but never enter the review queue, so this screen is where an admin
 * sees them at all.
 */
function Feeds({ toast }) {
  const status = useAsync(() => api.feeds(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function sync(e) {
    e.preventDefault();
    setError(null); setResult(null); setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const out = await api.syncFeeds({ where: f.where, radius_miles: Number(f.radius_miles) });
      setResult(out);
      if (out.ran) toast(`Imported ${out.imported}, updated ${out.updated}, removed ${out.removed}`);
      status.reload();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const s = status.data;
  const configured = s && (s.adzuna_configured || s.careeronestop_configured);

  return (
    <>
      <Stats>
        <Stat value={s?.adzuna_configured ? "On" : "Off"} label="Adzuna" />
        <Stat value={s?.careeronestop_configured ? "On" : "Off"} label="CareerOneStop" />
        <Stat value={(s?.imported || []).reduce((n, r) => n + r.count, 0)} label="Imported listings" />
        <Stat value={s?.location || "—"} label="Search area" />
      </Stats>

      <ErrorNote>{error}</ErrorNote>

      <Panel title="Pull from the feeds">
        <form className="pad filters" onSubmit={sync}>
          <Field label="Area" className="grow">
            <input name="where" id="f-where" defaultValue={s?.location || "Raleigh, NC"} />
          </Field>
          <Field label="Radius (miles)">
            <input name="radius_miles" id="f-radius" type="number" min="5" max="200"
                   defaultValue={s?.radius_miles || 50} />
          </Field>
          <button className="btn primary" disabled={busy || !configured}>
            {busy ? "Syncing…" : "Sync now"}
          </button>
        </form>

        {!configured && (
          <p className="note" style={{ padding: "0 14px 14px" }}>
            No feed is configured, so the board shows employer-posted jobs only. Set{" "}
            <code>ADZUNA_APP_ID</code> and <code>ADZUNA_APP_KEY</code>, or <code>COS_USER_ID</code>{" "}
            and <code>COS_TOKEN</code>, then restart the server.
          </p>
        )}

        {result && (
          <div className="pad" style={{ borderTop: "1px solid var(--line)" }}>
            {result.ran ? (
              <>
                <p>Imported <b>{result.imported}</b>, updated <b>{result.updated}</b> from {result.feeds.join(", ")}.
                   {result.removed > 0 && <> Removed <b>{result.removed}</b> listing{result.removed === 1 ? "" : "s"} the feeds stopped returning a month or more ago.</>}</p>
                {result.errors.length > 0 && (
                  <ul className="goeslist">{result.errors.map(e => <li key={e}>{e}</li>)}</ul>
                )}
              </>
            ) : <p className="note">{result.reason}</p>}
          </div>
        )}
      </Panel>

      <Panel title="What has been imported">
        <Table
          columns={[{ label: "Source" }, { label: "Listings", num: true }, { label: "Last import" }]}
          empty="Nothing imported yet."
          rows={(s?.imported || []).map(r => (
            <tr key={r.source}>
              <td><span className="strong">{r.source}</span></td>
              <td className="num">{r.count}</td>
              <td className="sub">{r.last_import ? fmtDate(r.last_import) : "—"}</td>
            </tr>
          ))} />
      </Panel>

      <p className="note">
        Imported listings skip the review queue — they were already public on another site. They also can't
        receive an application here, because no employer on this platform would be there to read it; students
        get an outbound link instead.
      </p>
    </>
  );
}
