import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

// The whole Suite is behind a login (Supabase Auth). Logins are made for the team only,
// from the first-time screen below or from WhatsApp → Setup → Team logins.
const BLUE = "#1B4F8A";
const MID_GREY = "#666666";
const field = { width: "100%", boxSizing: "border-box", padding: 12, fontSize: 15, border: "1px solid #ccc", borderRadius: 8, marginBottom: 10 };
const button = { width: "100%", background: BLUE, color: "#fff", border: "none", borderRadius: 8, padding: "12px 16px", fontWeight: 600, fontSize: 15, cursor: "pointer" };

export function logOut() {
  return supabase.auth.signOut();
}

export default function AuthGate({ children, title = "Paving Mauritius – Business Suite" }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [suitePassword, setSuitePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s || null));
    return () => data.subscription.unsubscribe();
  }, []);

  async function logIn() {
    setBusy(true); setError("");
    const { error: e } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (e) setError(/invalid/i.test(e.message) ? "Wrong email or password." : e.message);
    setBusy(false);
  }

  // First time: the WhatsApp password (already set in Vercel) proves it's the team, and creates the login.
  async function createFirst() {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/wa-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-suite-password": suitePassword },
        body: JSON.stringify({ action: "create_login", email: email.trim().toLowerCase(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error("The WhatsApp password is wrong.");
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      await logIn();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (session === undefined) return <div style={{ padding: 40, textAlign: "center", color: MID_GREY, fontFamily: "Segoe UI, Arial, sans-serif" }}>Loading…</div>;
  if (session) return children;

  const onEnter = (fn) => (e) => { if (e.key === "Enter") fn(); };
  return (
    <div style={{ minHeight: "100vh", background: "#F4F6FA", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "Segoe UI, Arial, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 2px 10px #0001", width: "100%", maxWidth: 400 }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: BLUE, marginBottom: 4 }}>🔒 {title}</div>
        <div style={{ fontSize: 13, color: MID_GREY, marginBottom: 16 }}>
          {mode === "login" ? "Log in to continue." : "Create your login. You need the WhatsApp password you already use in the Suite."}
        </div>
        {mode === "first" && (
          <input type="password" value={suitePassword} onChange={(e) => setSuitePassword(e.target.value)} placeholder="WhatsApp password (the old one)" autoComplete="off" style={field} />
        )}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="username" style={field} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter(mode === "login" ? logIn : createFirst)}
          placeholder={mode === "login" ? "Password" : "New password (at least 8 characters)"} autoComplete={mode === "login" ? "current-password" : "new-password"} style={field} />
        <button onClick={mode === "login" ? logIn : createFirst} disabled={busy || !email.trim() || !password || (mode === "first" && !suitePassword)} style={button}>
          {busy ? "…" : mode === "login" ? "Log in" : "Create my login"}
        </button>
        {error && <div style={{ color: "#B00020", marginTop: 12, fontSize: 13 }}>{error}</div>}
        <button onClick={() => { setMode(mode === "login" ? "first" : "login"); setError(""); }}
          style={{ background: "none", border: "none", color: BLUE, textDecoration: "underline", fontSize: 13, marginTop: 14, cursor: "pointer", padding: 0 }}>
          {mode === "login" ? "First time? Create your login" : "I already have a login"}
        </button>
      </div>
    </div>
  );
}
