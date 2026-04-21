"use client";

import { Suspense, FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Login fehlgeschlagen.");
      }

      const next = searchParams.get("next") || "/";
      router.push(next);
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="stack top-gap">
      <div>
        <label>Benutzername</label>
        <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
      </div>
      <div>
        <label>Passwort</label>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
      </div>

      {error ? <p className="subtle" style={{ color: "#b42318", fontWeight: 700 }}>{error}</p> : null}

      <button className="btn" type="submit" disabled={busy || !username || !password}>
        {busy ? "Anmeldung..." : "Anmelden"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="dashboard-page" style={{ maxWidth: 560, margin: "0 auto", paddingTop: 48 }}>
      <section className="panel">
        <h1>Gloria Login</h1>
        <p className="subtle">Bitte mit Ihrem Benutzerkonto anmelden.</p>
        <Suspense fallback={<p className="subtle top-gap">Login wird vorbereitet...</p>}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
