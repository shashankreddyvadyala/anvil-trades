import { useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Panel, Table, Tag, Stat, Stats, Field, ErrorNote, fmtDate, useAsync } from "../ui.jsx";

const STAGES = ["submitted", "reviewing", "interview", "offer", "rejected"];

export default function Employer({ page, navigate, toast }) {
  switch (page) {
    case "jobs":       return <Postings navigate={navigate} toast={toast} />;
    case "job":        return <PostingForm navigate={navigate} toast={toast} />;
    case "applicants": return <Applicants toast={toast} />;
    default:           return <Profile toast={toast} />;
  }
}

/* ------------------------------------------------------------------ */

function Profile({ toast }) {
  const { profile, refreshProfile } = useAuth();
  const postings = useAsync(() => api.postings(), []);
  const apps = useAsync(() => api.applications(), []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      refreshProfile(await api.updateEmployer(profile.employer_id, f));
      toast("Company profile saved");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const live = (postings.data || []).filter(j => j.status === "approved").length;

  return (
    <>
      <Stats>
        <Stat value={postings.data?.length ?? "—"} label="Postings" />
        <Stat value={postings.loading ? "—" : live} label="Live" />
        <Stat value={apps.data?.length ?? "—"} label="Applicants" />
        <Stat value={profile.verified ? "Verified" : "Unverified"} label="Account status" />
      </Stats>

      <Panel title={`Employer record — ${profile.employer_id}`}
             action={<Tag>{profile.verified ? "verified" : "unverified"}</Tag>}>
        <form className="pad" onSubmit={save}>
          <div className="formgrid">
            <Field label="Company name">
              <input name="company_name" id="e-name" defaultValue={profile.company_name} required />
            </Field>
            <Field label="Industry">
              <input name="industry" id="e-ind" defaultValue={profile.industry} required />
            </Field>
            <Field label="City and state">
              <input name="location" id="e-loc" defaultValue={profile.location} required />
            </Field>
          </div>
          <ErrorNote>{error}</ErrorNote>
          <div className="row-between" style={{ marginTop: 14 }}>
            <span className="note">Verification is granted by a regional admin — employers can't set it themselves.</span>
            <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </form>
      </Panel>

      {!profile.verified && (
        <p className="note">
          Your postings stay hidden from students until an admin verifies this company.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Postings({ navigate, toast }) {
  const postings = useAsync(() => api.postings(), []);
  const [error, setError] = useState(null);

  async function remove(j) {
    const who = j.applicant_count
      ? ` Its ${j.applicant_count} application${j.applicant_count === 1 ? "" : "s"} will be deleted too.`
      : "";
    if (!window.confirm(`Delete "${j.title}"?${who} This can't be undone.`)) return;
    setError(null);
    try {
      await api.deletePosting(j.job_id);
      toast(`Deleted ${j.job_id}`);
      postings.reload();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <ErrorNote>{error}</ErrorNote>
      <Panel title="Postings"
             action={<button className="btn primary sm" onClick={() => navigate("job", "new")}>New posting</button>}>
        <Table
          columns={[{ label: "Title" }, { label: "Wage range", num: true }, { label: "Review status" },
                    { label: "Reviewing admin" }, { label: "Applicants", num: true }, { label: "" }]}
          empty="No postings yet. Create your first one."
          rows={(postings.data || []).map(j => (
            <tr key={j.job_id}>
              <td><span className="strong">{j.title}</span><div className="id">{j.job_id}</div></td>
              <td className="num">{j.wage_range}</td>
              <td><Tag>{j.status}</Tag></td>
              <td className="sub">{j.admin_name || "—"}</td>
              <td className="num">{j.applicant_count}</td>
              <td>
                <div className="btnrow">
                  <button className="btn sm" onClick={() => navigate("job", j.job_id)}>Edit</button>
                  <button className="btn sm danger" onClick={() => remove(j)}>Delete</button>
                </div>
              </td>
            </tr>
          ))} />
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ */

function PostingForm({ navigate, toast }) {
  const id = navigate.param;
  const isNew = id === "new";
  const postings = useAsync(() => api.postings(), []);
  const admins = useAsync(() => api.admins(), []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (postings.loading || admins.loading) return <p className="empty">Loading…</p>;
  const job = isNew ? null : (postings.data || []).find(j => j.job_id === id);

  async function save(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      if (isNew) { const created = await api.createPosting(f); toast(`${created.job_id} created — pending review`); }
      else { await api.updatePosting(id, f); toast(`${id} updated — back in review`); }
      navigate("jobs");
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <>
      <div className="row-between">
        <button className="btn sm" onClick={() => navigate("jobs")}>&larr; Back to postings</button>
      </div>
      <Panel title={isNew ? "New posting" : `Edit ${id}`}>
        <form className="pad" onSubmit={save}>
          <div className="formgrid">
            <Field label="Job title">
              <input name="title" id="j-title" defaultValue={job?.title || ""} required
                     placeholder="Apprentice Electrician" />
            </Field>
            <Field label="Wage range">
              <input name="wage_range" id="j-wage" defaultValue={job?.wage_range || ""} required
                     placeholder="$22-$26/hr" />
            </Field>
            <Field label="Reviewing admin">
              <select name="admin_id" id="j-admin" defaultValue={job?.admin_id || admins.data[0]?.admin_id}>
                {admins.data.map(a => (
                  <option key={a.admin_id} value={a.admin_id}>{a.name} — {a.managed_region}</option>
                ))}
              </select>
            </Field>
          </div>
          <ErrorNote>{error}</ErrorNote>
          <div className="row-between" style={{ marginTop: 14 }}>
            <span className="note">
              {isNew
                ? <>New postings are created with status <code>pending</code> and stay invisible to students until approved.</>
                : <>Editing an approved posting sends it back to <code>pending</code> for re-review.</>}
            </span>
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create posting" : "Save changes"}
            </button>
          </div>
        </form>
      </Panel>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Applicants({ toast }) {
  const apps = useAsync(() => api.applications(), []);
  const [error, setError] = useState(null);

  async function setStatus(id, status) {
    setError(null);
    try {
      await api.setApplicationStatus(id, status);
      toast(`${id} → ${status}`);
      apps.reload();
    } catch (err) { setError(err.message); }
  }

  const rows = apps.data || [];
  const count = s => rows.filter(a => a.status === s).length;

  return (
    <>
      <Stats>
        <Stat value={rows.length} label="Total applicants" />
        <Stat value={count("submitted") + count("reviewing")} label="Needs review" />
        <Stat value={count("interview")} label="Interviewing" />
        <Stat value={count("offer")} label="Offers out" />
      </Stats>

      <ErrorNote>{error}</ErrorNote>

      <Panel title="Applicant pipeline">
        <Table
          columns={[{ label: "Student" }, { label: "Applied to" }, { label: "Date", num: true },
                    { label: "Status" }, { label: "Change status" }]}
          empty="No one has applied to your postings yet."
          rows={rows.map(a => (
            <tr key={a.application_id}>
              <td>
                <span className="strong">{a.student_name}</span>
                <div className="sub">{a.school} · class of {a.grad_year}</div>
              </td>
              <td>{a.title}<div className="id">{a.application_id}</div></td>
              <td className="num">{fmtDate(a.applied_date)}</td>
              <td><Tag>{a.status}</Tag></td>
              <td style={{ minWidth: 150 }}>
                {a.status === "withdrawn"
                  ? <span className="sub">Withdrawn by student</span>
                  : <select value={a.status} aria-label={`Status for ${a.student_name}`}
                            onChange={e => setStatus(a.application_id, e.target.value)}>
                      {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>}
              </td>
            </tr>
          ))} />
      </Panel>
    </>
  );
}
