/**
 * Thin fetch wrapper. Turns API errors into throwables.
 *
 * Signing in sets an httpOnly cookie, and the browser sends it on every
 * request by itself. This file never sees the session token and never stores
 * it: anything kept in localStorage can be read by any script that ends up
 * running on the page, which is exactly what an httpOnly cookie prevents.
 *
 * The base is RELATIVE by default, so the built app talks to whatever origin
 * it was served from — that is what makes one-service deployment work, and it
 * means no host name is ever baked into the bundle at build time. In
 * development Vite proxies /api to the API port (see vite.config.js).
 * VITE_API_URL is only needed if you host the frontend and API separately.
 */
const BASE = import.meta.env.VITE_API_URL || "/api";

/* Earlier versions of this app kept the token in localStorage. Remove any
   copy a returning visitor's browser still holds. */
try { localStorage.removeItem("anvil.token"); } catch { /* storage blocked */ }

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 204) return null;

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Multipart variant — fetch must set the boundary itself, so no Content-Type here. */
async function upload(path, formData) {
  const res = await fetch(BASE + path, {
    method: "POST",
    credentials: "include",
    body: formData
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Upload failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Query string builder that drops empty and undefined values. */
function qs(params = {}) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") out.set(k, v);
  }
  return out.toString();
}

export const api = {
  // resumes
  config: () => request("/config"),
  myResume: () => request("/resumes/me"),
  uploadResumeFile: file => {
    const fd = new FormData();
    fd.append("resume", file);
    return upload("/resumes", fd);
  },
  uploadResumeText: text => request("/resumes", { method: "POST", body: { text } }),
  analyzeResume: () => request("/resumes/me/analysis", { method: "POST" }),
  deleteResume: () => request("/resumes/me", { method: "DELETE" }),

  // auth
  login: body => request("/auth/login", { method: "POST", body }),
  signupStudent: body => request("/auth/signup/student", { method: "POST", body }),
  signupEmployer: body => request("/auth/signup/employer", { method: "POST", body }),
  me: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  logoutEverywhere: () => request("/auth/logout-all", { method: "POST" }),
  sessions: () => request("/auth/sessions"),
  changePassword: body => request("/auth/password", { method: "PATCH", body }),

  // reference data
  trades: () => request("/trades"),
  programs: params => request("/programs?" + qs(params)),
  jobs: params => request("/jobs?" + qs(params)),
  admins: () => request("/admins"),
  employers: () => request("/employers"),
  students: () => request("/students"),
  stats: () => request("/stats"),

  // geolocation
  setStudentLocation: (id, latitude, longitude) =>
    request(`/students/${id}/location`, { method: "PUT", body: { latitude, longitude } }),

  // job feeds (admin)
  feeds: () => request("/feeds"),
  syncFeeds: body => request("/feeds/sync", { method: "POST", body: body || {} }),

  // profiles
  updateStudent: (id, body) => request(`/students/${id}`, { method: "PATCH", body }),
  updateEmployer: (id, body) => request(`/employers/${id}`, { method: "PATCH", body }),
  setVerification: (id, verified) => request(`/employers/${id}/verification`, { method: "PATCH", body: { verified } }),

  // postings
  postings: params => request("/postings?" + qs(params)),
  createPosting: body => request("/postings", { method: "POST", body }),
  updatePosting: (id, body) => request(`/postings/${id}`, { method: "PATCH", body }),
  deletePosting: id => request(`/postings/${id}`, { method: "DELETE" }),
  moderate: (id, decision) => request(`/postings/${id}/moderation`, { method: "PATCH", body: { decision } }),

  // applications
  applications: () => request("/applications"),
  apply: job_id => request("/applications", { method: "POST", body: { job_id } }),
  setApplicationStatus: (id, status) => request(`/applications/${id}`, { method: "PATCH", body: { status } }),

  // quiz
  quizQuestions: () => request("/quiz"),
  myQuiz: () => request("/quiz/me"),
  submitQuiz: answers => request("/quiz", { method: "POST", body: { answers } })
};
