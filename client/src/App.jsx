import { useCallback, useMemo, useState } from "react";
import { useAuth } from "./auth.jsx";
import { useToast } from "./ui.jsx";
import Auth from "./pages/Auth.jsx";
import Student from "./pages/Student.jsx";
import Employer from "./pages/Employer.jsx";
import Admin from "./pages/Admin.jsx";

/** Sidebar entries per role. `page` is the key each role module switches on. */
const NAV = {
  student: [
    { page: "dashboard", label: "Dashboard" },
    { page: "quiz", label: "Trade quiz" },
    { page: "resume", label: "Resume scan" },
    { page: "programs", label: "Programs" },
    { page: "jobs", label: "Job board" },
    { page: "apps", label: "My applications" },
    { page: "profile", label: "My profile" }
  ],
  employer: [
    { page: "profile", label: "Company profile" },
    { page: "jobs", label: "Job postings" },
    { page: "applicants", label: "Applicants" }
  ],
  admin: [
    { page: "overview", label: "Overview" },
    { page: "moderation", label: "Posting queue" },
    { page: "employers", label: "Employers" },
    { page: "students", label: "Students" },
    { page: "programs", label: "Program data" },
    { page: "feeds", label: "Job feed" }
  ]
};

const HEADINGS = {
  student: {
    dashboard: ["Dashboard", "Your top trades, your resume match, and what to do next."],
    quiz:      ["Trade quiz", "Six questions, scored on the server against every trade in the program catalog."],
    resume:    ["Resume scan", "Upload a resume and have it read against every program and open job."],
    programs:  ["Programs", "Cost, time to certify, and what graduates start on — sourced per row."],
    jobs:      ["Job board", "Approved postings from verified employers, plus listings imported from outside boards."],
    apps:      ["My applications", "Everything you've applied to, newest first."],
    profile:   ["My profile", "The student record employers see when you apply."]
  },
  employer: {
    profile:    ["Company profile", "Your employer record. Verification is granted by a regional admin."],
    jobs:       ["Job postings", "Create and edit postings. New postings enter the admin review queue."],
    job:        ["Posting", "Postings go back through review whenever they change."],
    applicants: ["Applicants", "Students who applied to your postings. Move them through your hiring stages."]
  },
  admin: {
    overview:   ["Admin overview", "Platform activity across students, employers, and postings."],
    moderation: ["Posting queue", "Approve or reject postings before students can see them."],
    employers:  ["Employers", "Verify companies. Unverified employers' jobs stay hidden from students."],
    students:   ["Students", "Read-only roster with quiz completion."],
    programs:   ["Program data", "The cost, wage and debt figures shown to every student."],
    feeds:      ["Job feed", "Listings imported from outside job boards, and when they last refreshed."]
  }
};

const HOME = { student: "dashboard", employer: "profile", admin: "overview" };
const ROLE_VIEW = { student: Student, employer: Employer, admin: Admin };

export default function App() {
  const { booting, user, role, profile, logout, logoutEverywhere } = useAuth();
  const [route, setRoute] = useState({ page: null, param: null });
  const [toastNode, toast] = useToast();

  const navigate = useCallback((page, param = null) => {
    setRoute({ page, param });
    window.scrollTo(0, 0);
  }, []);
  navigate.param = route.param;

  // Sub-pages (a posting form) aren't sidebar entries, so remember which nav
  // item they belong under for the highlight.
  const PARENT = { job: "jobs" };

  // Fall back to the role's home page whenever the remembered route isn't a
  // page this role has — e.g. after signing out of an employer account and
  // back in as an admin, when "applicants" no longer exists.
  const page = (role && route.page && HEADINGS[role][route.page]) ? route.page : (role ? HOME[role] : null);
  const heading = useMemo(() => (role && HEADINGS[role][page]) || ["", ""], [role, page]);

  if (booting) return <div className="boot">Loading Anvil…</div>;
  if (!user) return <Auth />;

  const RoleView = ROLE_VIEW[role];
  const activeNav = PARENT[page] || page;
  const contextLine =
    role === "admin" ? `Region: ${profile.managed_region}`
    : role === "employer" ? `${profile.location}${profile.verified ? "" : " · unverified"}`
    : profile.school;
  const displayName =
    role === "employer" ? profile.company_name : profile.name;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-name">Anvil</div>
            <div className="brand-sub">Trades Portal</div>
          </div>
        </div>

        <div className="who">
          <span className="lbl">{role}</span>
          <div className="who-name">{displayName}</div>
          <div className="sub">{user.email}</div>
        </div>

        <nav className="menu">
          {NAV[role].map(n => (
            <button key={n.page}
                    onClick={() => navigate(n.page)}
                    aria-current={activeNav === n.page ? "page" : undefined}>
              {n.label}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <div className="btnrow">
            <button className="btn sm" onClick={logout}>Sign out</button>
            <button className="btn sm" onClick={logoutEverywhere}
                    title="Revoke every session for this account, on every device">
              Everywhere
            </button>
          </div>
        </div>
      </aside>

      <main>
        <div className="topbar">
          <div>
            <h1>{heading[0]}</h1>
            <p>{heading[1]}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="lbl">{role}</div>
            <div className="sub">{contextLine}</div>
          </div>
        </div>
        <div className="wrap">
          <RoleView page={page} navigate={navigate} toast={toast} />
        </div>
      </main>

      {toastNode}
    </div>
  );
}
