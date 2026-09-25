import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "./api.js";

const AuthContext = createContext(null);

/**
 * Holds the signed-in user and their profile row.
 *
 * On boot it asks the server who is signed in. The session cookie is
 * httpOnly, so the page can't look at it directly — and doesn't need to:
 * /auth/me answers from the cookie, and says "nobody" for a visitor who is
 * signed out or whose session expired while the tab was closed.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null); // { user, profile }
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    api.me()
      .then(d => setSession(d?.user ? d : null))
      .catch(() => setSession(null))
      .finally(() => setBooting(false));
  }, []);

  const adopt = useCallback(({ user, profile }) => {
    setSession({ user, profile });
  }, []);

  const value = {
    booting,
    user: session?.user || null,
    profile: session?.profile || null,
    role: session?.user?.role || null,
    login: async creds => adopt(await api.login(creds)),
    signupStudent: async body => adopt(await api.signupStudent(body)),
    signupEmployer: async body => adopt(await api.signupEmployer(body)),
    /* Signing out has to reach the server: the cookie is httpOnly so the page
       can't clear it, and the session row has to be revoked or the token would
       stay valid for a week. The local state is cleared either way — a failed
       request should never leave someone stuck looking signed in. */
    logout: async () => {
      try { await api.logout(); } catch { /* offline — clear locally anyway */ }
      setSession(null);
    },
    logoutEverywhere: async () => {
      try { await api.logoutEverywhere(); } catch { /* as above */ }
      setSession(null);
    },
    /** Called after a profile edit so the header and forms stay in sync. */
    refreshProfile: profile => setSession(s => (s ? { ...s, profile } : s))
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
};
