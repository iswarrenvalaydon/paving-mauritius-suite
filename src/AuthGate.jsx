import { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

// The whole Suite is behind a login (Supabase Auth). Logins are added by the team in
// WhatsApp → Setup → Team logins; there is no way to create one from this screen.
const BLUE = "#1B4F8A";
const MID_GREY = "#666666";
const field = { width: "100%", boxSizing: "border-box", padding: 12, fontSize: 15, border: "1px solid #ccc", borderRadius: 8, marginBottom: 10 };
const button = { width: "100%", background: BLUE, color: "#fff", border: "none", borderRadius: 8, padding: "12px 16px", fontWeight: 600, fontSize: 15, cursor: "pointer" };

export function logOut() {
  return supabase.auth.signOut();
}

export default function AuthGate({ children, title = "Paving Mauritius – Business Suite" }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  if (session === undefined) return <div style={{ padding: 40, textAlign: "center", color: MID_GREY, fontFamily: "Segoe UI, Arial, sans-serif" }}>Loading…</div>;
  if (session) return children;

  const onEnter = (fn) => (e) => { if (e.key === "Enter") fn(); };
  return (
    <div style={{ minHeight: "100vh", background: "#F4F6FA", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "Segoe UI, Arial, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 2px 10px #0001", width: "100%", maxWidth: 400 }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: BLUE, marginBottom: 4 }}>🔒 {title}</div>
        <div style={{ fontSize: 13, color: MID_GREY, marginBottom: 16 }}>
          Log in to continue.
        </div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="username" style={field} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter(logIn)}
          placeholder="Password" autoComplete="current-password" style={field} />
        <button onClick={logIn} disabled={busy || !email.trim() || !password} style={button}>
          {busy ? "…" : "Log in"}
        </button>
        {error && <div style={{ color: "#B00020", marginTop: 12, fontSize: 13 }}>{error}</div>}
        <div style={{ fontSize: 12, color: MID_GREY, marginTop: 14 }}>No login? Ask Iswarren or Julien to add you in WhatsApp → Setup → Team logins.</div>
      </div>
    </div>
  );
}
