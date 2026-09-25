/** Small presentational building blocks shared by every page. */
import { useEffect, useState } from "react";

export const usd = n => "$" + Number(n || 0).toLocaleString("en-US");

export const fmtDate = iso => {
  const d = new Date(String(iso).replace(" ", "T"));
  return isNaN(d) ? String(iso) : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
};

const TONE = {
  approved: "ok", offer: "ok", verified: "ok", complete: "ok",
  pending: "warn", reviewing: "warn", interview: "warn",
  submitted: "info",
  rejected: "bad", withdrawn: "bad", unverified: "bad"
};

export const Tag = ({ children, tone }) =>
  <span className={"tag " + (tone || TONE[children] || "")}>{children}</span>;

export const Panel = ({ title, action, children }) => (
  <section className="panel">
    {title && <header><h2>{title}</h2>{action}</header>}
    {children}
  </section>
);

export const Stat = ({ value, label }) => (
  <div className="stat"><b>{value}</b><span>{label}</span></div>
);

export const Stats = ({ children }) => <div className="stats">{children}</div>;

export const Field = ({ label, hint, children, className = "" }) => (
  <label className={"field " + className}>
    <span>{label}</span>
    {children}
    {hint && <em className="hint">{hint}</em>}
  </label>
);

export const Table = ({ columns, rows, empty = "Nothing here yet." }) => {
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>{columns.map((c, i) => <th key={i} className={c.num ? "num" : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
};

export const Bar = ({ pct }) => <div className="bar"><i style={{ width: `${pct}%` }} /></div>;

/** How far away something is, or nothing at all when we don't know. */
export const Distance = ({ miles }) =>
  miles == null ? null : <span className="miles">{miles} mi</span>;

/**
 * Ask the browser where the viewer is.
 *
 * Geolocation needs a secure context, the viewer's consent, and a device that
 * can answer — any of which can fail, so this resolves to an error message
 * rather than throwing, and every caller treats failure as "carry on without
 * coordinates".
 */
export function requestBrowserLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      return resolve({ error: "This browser can't share a location." });
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      err => resolve({
        error: err.code === err.PERMISSION_DENIED
          ? "Location permission was denied — distances will use the town on your profile."
          : "Couldn't get a location fix. Distances will use the town on your profile."
      }),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}

/** Inline error banner used by forms. */
export const ErrorNote = ({ children }) => children ? <p className="errornote" role="alert">{children}</p> : null;

/** Transient confirmation message. */
export function useToast() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2400);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? <div className="toast" role="status">{msg}</div> : null;
  return [node, setMsg];
}

/** Standard async page state: loading, error, data. */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    Promise.resolve(fn())
      .then(data => live && setState({ loading: false, error: null, data }))
      .catch(err => live && setState({ loading: false, error: err.message, data: null }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce(n => n + 1) };
}
