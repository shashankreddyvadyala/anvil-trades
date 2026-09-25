import { useRef, useState } from "react";
import { api } from "../api.js";
import { Panel, Tag, Bar, Distance, ErrorNote, usd, useAsync } from "../ui.jsx";

/**
 * Upload a resume, have it read, and get programs and jobs back.
 *
 * The file is parsed on the SERVER, not here — the browser just posts it.
 * That keeps one extraction path for PDF, DOCX and text, and means the
 * server never has to trust text the client claims came out of a file.
 */
export default function Resume({ toast, navigate }) {
  const stored = useAsync(() => api.myResume(), []);
  const config = useAsync(() => api.config(), []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // "upload" | "scan" | null
  const fileInput = useRef(null);
  const [dragging, setDragging] = useState(false);

  const row = stored.data;
  const analysis = row?.analysis;
  const aiEnabled = config.data?.ai_enabled;

  async function send(fn, kind) {
    setError(null); setBusy(kind);
    try {
      await fn();
      stored.reload();
    } catch (err) { setError(err.message); }
    finally { setBusy(null); }
  }

  const uploadFile = file => {
    if (!file) return;
    send(() => api.uploadResumeFile(file), "upload");
  };

  function pasteText(e) {
    e.preventDefault();
    const text = new FormData(e.currentTarget).get("text");
    if (!text || text.trim().length < 40) {
      return setError("Add a bit more — a few lines of classes, jobs or tools is enough to work with.");
    }
    send(() => api.uploadResumeText(text), "upload");
  }

  const scan = () => send(async () => {
    await api.analyzeResume();
    toast("Resume scanned");
  }, "scan");

  const startOver = () => send(() => api.deleteResume(), "upload");

  return (
    <>
      <ErrorNote>{error}</ErrorNote>

      {!row && (
        <Panel title="Upload a resume">
          <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <label
              className={"drop" + (dragging ? " over" : "")}
              onDragEnter={e => { e.preventDefault(); setDragging(true); }}
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); uploadFile(e.dataTransfer.files?.[0]); }}>
              <h3>{busy === "upload" ? "Reading…" : "Drop a resume here, or choose a file"}</h3>
              <p>PDF, Word (.docx) or plain text, up to 5 MB. The file is read for its text and
                 the text is what gets stored — the file itself is never saved.</p>
              <span className="btn">Choose file</span>
              <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md"
                     onChange={e => uploadFile(e.target.files?.[0])} />
            </label>

            <form onSubmit={pasteText} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <label className="field">
                <span>Or paste the text</span>
                <textarea className="paste" name="text" id="resume-text"
                          placeholder="Paste your resume, or just list your classes, jobs, tools and certifications." />
              </label>
              <div className="row-between">
                <span className="note">No resume yet? A plain list of shop classes, part-time jobs and tools works.</span>
                <button className="btn primary" disabled={busy === "upload"}>Use this text</button>
              </div>
            </form>
          </div>
        </Panel>
      )}

      {row && !analysis && (
        <Panel title="Ready to scan">
          <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="filerow">
              <span className="fname">{row.filename}</span>
              <span className="fmeta">{row.char_count.toLocaleString()} characters</span>
              <span className="spacer" />
              <button className="btn sm" onClick={startOver} disabled={busy}>Remove</button>
              <button className="btn sm primary" onClick={scan} disabled={busy}>
                {busy === "scan" ? "Scanning…" : aiEnabled ? "Scan with AI" : "Match by keyword"}
              </button>
            </div>
            {busy === "scan" && (
              <span className="pulse"><i />Reading the resume against every program and open job…</span>
            )}
            <span className="note">
              {aiEnabled
                ? "The text goes to Claude with the program and job catalogs. Nothing else is sent."
                : "No ANTHROPIC_API_KEY is set on the server, so this runs the offline keyword matcher. Set one for a real reading of the resume."}
            </span>
          </div>
        </Panel>
      )}

      {analysis && <Results row={row} analysis={analysis} onNew={startOver} navigate={navigate} toast={toast} />}

      <p className="note">
        Recommendations are a starting point, not a decision. Check any program's real cost and any
        employer's posting before acting on them, and remember an AI can misread a resume.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Chips({ items, hit }) {
  if (!items.length) return <span className="note">None found in the resume.</span>;
  return <div className="chips">{items.map(t => <span className={"chip2" + (hit ? " hit" : "")} key={t}>{t}</span>)}</div>;
}

function Results({ row, analysis, onNew, navigate, toast }) {
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

  return (
    <>
      <Panel
        title="What the scan found"
        action={
          <div className="btnrow">
            <span className={"engine " + (row.engine === "ai" ? "ai" : "local")}>
              {row.engine === "ai" ? "Scanned by Claude" : "Offline keyword match"}
            </span>
            <button className="btn sm" onClick={onNew}>Scan a new resume</button>
          </div>
        }>
        <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {analysis.summary && <p>{analysis.summary}</p>}
          <div className="formgrid">
            <div><span className="lbl reslabel">Skills</span><Chips items={analysis.skills} hit /></div>
            <div><span className="lbl reslabel">Certifications</span><Chips items={analysis.certifications} /></div>
            <div><span className="lbl reslabel">Tools &amp; equipment</span><Chips items={analysis.tools} /></div>
          </div>
          {analysis.strengths.length > 0 && (
            <div>
              <span className="lbl reslabel">Working in your favour</span>
              <ul className="goeslist">{analysis.strengths.map(s => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
        </div>
      </Panel>

      {analysis.program_recommendations.length > 0 && (
        <Panel title="Recommended programs">
          {analysis.program_recommendations.map(m => (
            <div className="rec" key={m.program_id}>
              <div className="fit">{m.fit}<small>fit</small></div>
              <div className="rec-main">
                <div className="strong">{m.program.provider_name}</div>
                <div className="sub">
                  {m.program.trade} · {m.program.location} · {m.program.time_to_certify}
                </div>
                <Bar pct={m.fit} />
                <div className="why">{m.why}</div>
                {m.gaps.length > 0 && <div className="gaps"><b>To pick up:</b> {m.gaps.join(" · ")}</div>}
              </div>
              <div className="rec-side">
                <span className="fmeta">{usd(m.program.cost)} cost</span>
                <span className="fmeta">{usd(m.program.avg_starting_wage)} start</span>
                <Distance miles={m.program.distance_miles} />
                <button className="btn sm" onClick={() => navigate("programs", m.program.trade)}>Compare</button>
              </div>
            </div>
          ))}
        </Panel>
      )}

      <ErrorNote>{error}</ErrorNote>

      {analysis.job_recommendations.length > 0 && (
        <Panel title="Jobs worth applying to">
          {analysis.job_recommendations.map(m => (
            <div className="rec" key={m.job_id}>
              <div className="fit">{m.fit}<small>fit</small></div>
              <div className="rec-main">
                <div className="strong">{m.job.title}</div>
                <div className="sub">
                  {m.job.company_name} · {m.job.location} · {m.job.wage_range}
                  {m.job.source !== "employer" && <> · <span className="imported">imported</span></>}
                </div>
                <div className="why">{m.why}</div>
                {m.missing.length > 0 && <div className="gaps"><b>Not shown yet:</b> {m.missing.join(" · ")}</div>}
              </div>
              <div className="rec-side">
                {m.job.source !== "employer"
                  ? <a className="outlink" href={m.job.source_url} target="_blank" rel="noopener noreferrer">Apply on their site</a>
                  : appliedTo[m.job_id]
                    ? <Tag>{appliedTo[m.job_id].status}</Tag>
                    : <button className="btn sm primary" onClick={() => apply(m.job_id)}>Apply</button>}
              </div>
            </div>
          ))}
        </Panel>
      )}

      {analysis.next_steps.length > 0 && (
        <Panel title="Next steps">
          <div className="pad">
            <ol className="steps">{analysis.next_steps.map(s => <li key={s}>{s}</li>)}</ol>
          </div>
        </Panel>
      )}
    </>
  );
}
