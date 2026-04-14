"use client";

import { useEffect, useMemo, useState } from "react";
import type { DashboardData, LearningResponse, ScriptConfig, Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";

const SAMPLE_CSV = `company,contactName,phone,email,topic,note,nextCallAt
Musterbau GmbH,Herr Neumann,+49 2339 555100,neumann@musterbau.de,betriebliche Krankenversicherung,120 Mitarbeitende; Recruiting Thema,
Sprockhoevel Energieberatung,Frau Peters,+49 2324 555200,peters@se-beratung.de,Energie,Vertragsverlängerung in 90 Tagen,2026-04-15T10:00:00.000Z`;

const EMPTY_DATA: DashboardData = {
  leads: [],
  reports: [],
  scripts: [],
  reportStorageMode: "file",
  scriptsStorageMode: "file",
  metrics: {
    dialAttempts: 0,
    conversations: 0,
    appointments: 0,
    rejections: 0,
    callbacksOpen: 0,
    gatekeeperLoops: 0,
    transferSuccessRate: 0,
  },
};

const EMPTY_LEARNING: LearningResponse = {
  insights: [],
  globalSummary: [],
};

function formatDate(value?: string) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function speakText(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "de-DE";

  const germanVoice = window.speechSynthesis
    .getVoices()
    .find((voice) => voice.lang.toLowerCase().startsWith("de"));

  if (germanVoice) {
    utterance.voice = germanVoice;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function buildConversationLines(summary: string) {
  return summary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("Gloria:") || l.startsWith("Interessent:"))
    .map((l) => {
      const isGloria = l.startsWith("Gloria:");
      return { speaker: isGloria ? "Gloria" : "Interessent", text: l.replace(/^Gloria:|^Interessent:/, "").trim() };
    });
}

function detectLostStage(summary: string): string {
  const t = summary.toLowerCase();
  if (t.includes("appt_slot_iso") || t.includes("appt_slot_label")) {
    return "Terminbestätigung – Interessent hat nach Terminvorschlag abgesagt";
  }
  if (t.includes("prep_mode") || t.includes("prep_short") || t.includes("wann passt")) {
    return "Terminvereinbarung – Abbruch beim Erfassen der Termindaten";
  }
  if (t.includes("problem_confirm_pending") || t.includes("stellen sie sich vor")) {
    return "Nutzenargumentation – Interessent hat Mehrwert nicht gesehen";
  }
  if (t.includes("discovery") || t.includes("wie zufrieden") || t.includes("was wäre für sie")) {
    return "Bedarfsermittlung – kein Interesse nach Bedarfsabfrage";
  }
  if (t.includes("aufzeichnung") || t.includes("consent")) {
    return "Einwilligung – Gespräch nach Aufnahme-Abfrage abgebrochen";
  }
  return "Gesprächseinstieg – Entscheider nicht oder kaum erreicht";
}

function pickText(value: string | undefined, fallback?: string) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return fallback ?? "";
}

export default function HomePage() {
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [detailTopic, setDetailTopic] = useState<Topic>(TOPICS[0]);
  const [voiceTopic, setVoiceTopic] = useState<Topic>(TOPICS[0]);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceAudioUrl, setVoiceAudioUrl] = useState("");
  const [learning, setLearning] = useState<LearningResponse>(EMPTY_LEARNING);
  const [twilioTarget, setTwilioTarget] = useState("");
  const [twilioCompany, setTwilioCompany] = useState("Musterbau GmbH");
  const [twilioContactName, setTwilioContactName] = useState("Herr Neumann");
  const [twilioTopic, setTwilioTopic] = useState<Topic>(TOPICS[0]);
  const [notice, setNotice] = useState("Dashboard wird geladen ...");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draftScripts, setDraftScripts] = useState<Record<string, ScriptConfig>>({});
  const [selectedReport, setSelectedReport] = useState<DashboardData["reports"][number] | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const activeDraft = draftScripts[detailTopic];
  const reportRows = useMemo(() => data.reports.slice(0, 40), [data.reports]);

  async function loadDashboard() {
    const [dashboardResponse, learningResponse] = await Promise.all([
      fetch("/api/reports", { cache: "no-store" }),
      fetch("/api/learning", { cache: "no-store" }),
    ]);

    const payload = (await dashboardResponse.json()) as DashboardData;
    const learningPayload = (await learningResponse.json()) as LearningResponse;

    setData(payload);
    setLearning(learningPayload);
    setDraftScripts(
      payload.scripts.reduce<Record<string, ScriptConfig>>((acc, script) => {
        acc[script.topic] = {
          ...script,
          // KI-Konfiguration (OpenAI-driven fields)
          aiKeyInfo: pickText(script.aiKeyInfo, ""),
          gatekeeperTask: pickText(
            script.gatekeeperTask,
            "Bitte freundlich um Weiterleitung zur zuständigen Führungskraft.",
          ),
          gatekeeperBehavior: pickText(
            script.gatekeeperBehavior,
            "Erkläre kurz worum es geht wenn gefragt. Frage nach dem Namen der zuständigen Person. Bleib höflich aber bestimmt.",
          ),
          decisionMakerTask: pickText(
            script.decisionMakerTask,
            "Vereinbare einen 15-minütigen, unverbindlichen Beratungstermin mit Herrn Matthias Duic.",
          ),
          decisionMakerBehavior: pickText(
            script.decisionMakerBehavior,
            "Erkläre den Mehrwert klar und präzise. Gehe auf Einwände ein. Schlage konkrete Terminoptionen vor.",
          ),
          appointmentGoal: pickText(
            script.appointmentGoal,
            "Ein konkreter Beratungstermin mit Herrn Matthias Duic ist vereinbart, inklusive Datum und Uhrzeit.",
          ),
        };
        return acc;
      }, {}),
    );
    setNotice(
      `Aktueller Stand: ${payload.metrics.appointments} Termin(e), ${payload.metrics.callbacksOpen} offene Wiedervorlage(n).`,
    );
    setLoading(false);
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  function downloadSampleCsv() {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "gloria-muster-import.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }

  async function handleCsvImport() {
    setBusy(true);

    try {
      const response = await fetch("/api/campaigns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText }),
      });
      const payload = (await response.json()) as { imported?: number; error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "CSV konnte nicht importiert werden.");
      }

      setNotice(`CSV importiert: ${payload.imported ?? 0} neue Firmen in Gloria geladen.`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function applyLearning(topic: Topic) {
    const confirmed = confirm(
      `Möchten Sie die vorgeschlagenen Optimierungen für "${topic}" übernehmen?`,
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Optimierung konnte nicht angewendet werden.");
      }

      setNotice(`Gloria hat das Skript für ${topic} anhand der Gesprächsreports optimiert.`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Selbstoptimierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function saveScript(topic: Topic) {
    const draft = draftScripts[topic];

    if (!draft) {
      return;
    }

    setBusy(true);
    setSaveStatus(null);

    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json()) as {
        error?: string;
        storageMode?: "postgres" | "file";
      };

      if (!response.ok) {
        throw new Error(payload.error || "Skript konnte nicht gespeichert werden.");
      }

      setNotice(
        `Skript für ${topic} gespeichert und für Gloria übernommen. Gespeichert in ${payload.storageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}.`,
      );
      setSaveStatus({
        type: "success",
        message: `Erfolgreich gespeichert (${payload.storageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}).`,
      });
      await loadDashboard();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Skript speichern fehlgeschlagen.";
      setNotice(errorMessage);
      setSaveStatus({ type: "error", message: errorMessage });
    } finally {
      setBusy(false);
    }
  }

  async function testVoice() {
    setBusy(true);

    setVoicePreview("Vorschau wird geladen ...");
    setVoiceAudioUrl("");

    try {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: voiceTopic }),
      });

      const payload = (await response.json()) as {
        preview?: string;
        provider?: "elevenlabs" | "browser";
        audioBase64?: string;
        audioMimeType?: string;
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || payload.message || "Stimmtest konnte nicht geladen werden.");
      }

      setVoicePreview(payload.preview || "Keine Vorschau verfügbar.");

      if (payload.audioBase64 && payload.audioMimeType) {
        const url = `data:${payload.audioMimeType};base64,${payload.audioBase64}`;
        setVoiceAudioUrl(url);
        void new Audio(url).play().catch(() => undefined);
      } else {
        setVoiceAudioUrl("");
        speakText(payload.preview || "");
      }

      setNotice(payload.message || `Stimmtest für ${voiceTopic} gestartet.`);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `${error.message} - die Textvorschau konnte nicht geladen werden.`
          : "Stimmtest konnte nicht geladen werden.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startTwilioTestCall() {
    if (!twilioTarget.trim()) {
      setNotice("Bitte zuerst eine Zielnummer im internationalen Format eingeben, z. B. +492339123456.");
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/twilio/test-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: twilioTarget,
          company: twilioCompany,
          contactName: twilioContactName,
          topic: twilioTopic,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        sid?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Twilio-Testanruf konnte nicht gestartet werden.");
      }

      setNotice(`${payload.message || "Twilio-Testanruf gestartet."} SID: ${payload.sid || "-"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Twilio-Testanruf fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecording(reportId: string) {
    if (!confirm("Aufnahme wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.")) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(
        `/api/reports/recording?reportId=${encodeURIComponent(reportId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error("Aufnahme konnte nicht gelöscht werden.");
      }

      setNotice("Aufnahme erfolgreich gelöscht.");
      setSelectedReport((current) =>
        current?.id === reportId ? { ...current, recordingUrl: undefined } : current,
      );
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport(reportId: string) {
    if (!confirm("Report und Aufnahme wirklich komplett löschen? Diese Aktion kann nicht rückgängig gemacht werden.")) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(
        `/api/reports?reportId=${encodeURIComponent(reportId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error("Report konnte nicht gelöscht werden.");
      }

      setNotice("Report erfolgreich gelöscht.");
      setSelectedReport(null);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-page">
      <header className="duic-hero">
        <div>
          <p className="eyebrow">Agentur Duic Sprockhövel</p>
          <h1>Gloria Admin Dashboard</h1>
          <p className="hero-copy">
            Vertrieb, Telefonie und Lernlogik in einer Leitstelle: klar, schnell und auf Termine ausgerichtet.
          </p>
          <p className="hero-note">{loading ? "Lade Daten ..." : notice}</p>
        </div>
        <div className="hero-actions">
          <a className="btn ghost" href="/api/export/outlook">Outlook-CSV exportieren</a>
          <span className="pill">
            Reports: {data.reportStorageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}
          </span>
          <span className="pill">
            Skripte: {data.scriptsStorageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}
          </span>
          <span className="pill">Reports an Matthias.duic@agentur-duic-sprockhoevel.de</span>
        </div>
      </header>

      <section className="stats-grid">
        <article className="stat-card"><span>Wählversuche</span><strong>{data.metrics.dialAttempts}</strong></article>
        <article className="stat-card"><span>Gespräche</span><strong>{data.metrics.conversations}</strong></article>
        <article className="stat-card"><span>Termine</span><strong>{data.metrics.appointments}</strong></article>
        <article className="stat-card"><span>Absagen</span><strong>{data.metrics.rejections}</strong></article>
        <article className="stat-card"><span>Wiedervorlagen offen</span><strong>{data.metrics.callbacksOpen}</strong></article>
        <article className="stat-card"><span>Empfangs-Loop-Breaks</span><strong>{data.metrics.gatekeeperLoops}</strong></article>
        <article className="stat-card"><span>Durchstellquote</span><strong>{data.metrics.transferSuccessRate}%</strong></article>
      </section>

      <section className="workbench">
        <div className="stack">
          <article className="panel">
            <h2>Aufträge per CSV laden</h2>
            <p className="subtle">Format: company, contactName, phone, email, topic, note, nextCallAt</p>
            <textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} />
            <div className="row top-gap">
              <button className="btn" onClick={() => void handleCsvImport()} disabled={busy}>CSV importieren</button>
              <button className="btn ghost" onClick={downloadSampleCsv}>Muster-CSV herunterladen</button>
            </div>
          </article>

          <article className="panel">
            <h2>Gloria testen</h2>
            <div className="row">
              <select value={voiceTopic} onChange={(event) => setVoiceTopic(event.target.value as Topic)}>
                {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
              </select>
              <button className="btn" onClick={() => void testVoice()} disabled={busy}>
                {busy ? "Vorschau lädt ..." : "Stimme testen"}
              </button>
            </div>
            <div className="code-box top-gap">{voicePreview || "Noch keine Vorschau geladen."}</div>
            {voiceAudioUrl ? <audio controls src={voiceAudioUrl} className="audio-player" /> : null}
          </article>

          <article className="panel">
            <h2>Twilio Live-Testanruf</h2>
            <div className="field-grid">
              <div>
                <label>Zielnummer</label>
                <input value={twilioTarget} onChange={(event) => setTwilioTarget(event.target.value)} placeholder="+492339123456" />
              </div>
              <div>
                <label>Firma</label>
                <input value={twilioCompany} onChange={(event) => setTwilioCompany(event.target.value)} />
              </div>
              <div>
                <label>Ansprechpartner</label>
                <input value={twilioContactName} onChange={(event) => setTwilioContactName(event.target.value)} />
              </div>
              <div>
                <label>Thema</label>
                <select value={twilioTopic} onChange={(event) => setTwilioTopic(event.target.value as Topic)}>
                  {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                </select>
              </div>
            </div>
            <div className="row top-gap">
              <button className="btn" onClick={() => void startTwilioTestCall()} disabled={busy || !twilioTarget.trim()}>
                {busy ? "Anruf startet ..." : "Twilio-Testanruf starten"}
              </button>
            </div>
          </article>
        </div>

        <div className="stack">
          <article className="panel">
            <h2>Compliance & Ablauf</h2>
            <ul>
              <li>Direkte Offenlegung als digitale Assistentin im ersten Satz</li>
              <li>Aufnahmefreigabe wird immer vor dem eigentlichen Gespräch abgefragt</li>
              <li>Zielausgänge: Termin, Wiedervorlage oder klare Absage</li>
              <li>Gesprächsreports und Aufnahmen landen gesammelt im Dashboard</li>
              <li>Webhook für Telefonie: /api/calls/webhook</li>
            </ul>
          </article>

          <article className="panel">
            <h2>Gloria lernt aus Gesprächen</h2>
            <ul>
              {learning.globalSummary.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <div className="insight-grid">
              {learning.insights.map((insight) => (
                <div key={insight.topic} className="mini-panel">
                  <h3>{insight.topic}</h3>
                  <p className="subtle">{insight.totalConversations} Gespräche · {insight.appointmentRate}% Terminquote</p>
                  <ul>
                    {insight.recommendations.slice(0, 2).map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
                  </ul>
                  <button className="btn ghost" onClick={() => void applyLearning(insight.topic)} disabled={busy}>Optimierung übernehmen</button>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="panel top-section">
        <div className="row spread">
          <h2>Skripte für Gloria bearbeiten</h2>
          <select value={detailTopic} onChange={(event) => setDetailTopic(event.target.value as Topic)}>
            {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
          </select>
        </div>

        {activeDraft ? (
          <>
            <p className="subtle">
              Diese Konfiguration steuert den OpenAI-Call-Flow direkt. Gespeicherte Änderungen werden sofort von Gloria für neue Gespräche verwendet.
              Aktuelle Skript-Datenquelle: {data.scriptsStorageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}.
            </p>

            <p className="subtle top-gap"><strong>0) KI-Konfiguration</strong> – Diese Felder steuern das OpenAI-Gespräch. Gloria nutzt sie auf jeder Gesprächsrunde für Rollenerkennung und Antwortgenerierung.</p>
            <label>Basisinformationen (was bieten wir an – Kontext für OpenAI)</label>
            <textarea value={activeDraft.aiKeyInfo ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], aiKeyInfo: event.target.value } }))} />
            <label>Aufgabe beim Empfang (was soll Gloria beim Gatekeeper erreichen)</label>
            <textarea value={activeDraft.gatekeeperTask ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], gatekeeperTask: event.target.value } }))} />
            <label>Verhalten beim Empfang (wie soll Gloria sich verhalten)</label>
            <textarea value={activeDraft.gatekeeperBehavior ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], gatekeeperBehavior: event.target.value } }))} />
            <label>Aufgabe beim Entscheider (was soll Gloria beim Entscheider erreichen)</label>
            <textarea value={activeDraft.decisionMakerTask ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], decisionMakerTask: event.target.value } }))} />
            <label>Verhalten beim Entscheider (Argumentationsstil, Einwandbehandlung)</label>
            <textarea value={activeDraft.decisionMakerBehavior ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], decisionMakerBehavior: event.target.value } }))} />
            <label>Abschlussziel / Erfolgsdefinition (wann ist der Anruf erfolgreich)</label>
            <textarea value={activeDraft.appointmentGoal ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], appointmentGoal: event.target.value } }))} />

            <p className="subtle top-gap">
              Hinweis: Die bisherigen Leitfaden-Felder sind in der Admin-UI ausgeblendet.
              Für den neuen OpenAI-Twilio-Flow werden nur die KI-Konfigurationsfelder oben verwendet.
            </p>

            <div className="row top-gap">
              <button className="btn" onClick={() => void saveScript(detailTopic)} disabled={busy}>Skript speichern</button>
              <span className="subtle">Alle Felder werden gespeichert und sofort von Gloria für neue Gespräche verwendet.</span>
            </div>
            {saveStatus ? (
              <p
                className="subtle"
                role="status"
                style={{
                  marginTop: 8,
                  color: saveStatus.type === "success" ? "#1f7a42" : "#b42318",
                  fontWeight: 700,
                }}
              >
                {saveStatus.message}
              </p>
            ) : null}
          </>
        ) : (
          <p className="subtle">Für dieses Thema ist noch kein Skript geladen.</p>
        )}
      </section>

      <section className="report-grid top-section">
        <article className="panel">
          <h2>Gesprächsreports & Aufnahmen</h2>
          <table>
            <thead>
              <tr><th>Firma</th><th>Thema</th><th>Ergebnis</th><th>Termin / Callback</th><th>Aufnahme</th><th></th></tr>
            </thead>
            <tbody>
              {reportRows.map((report) => (
                <tr key={report.id}>
                  <td><strong>{report.company}</strong>{report.contactName ? <div className="subtle">{report.contactName}</div> : null}</td>
                  <td>{report.topic}</td>
                  <td>
                    <span className={`status ${report.outcome === "Absage" ? "absage" : report.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                      {report.outcome}
                    </span>
                  </td>
                  <td>{formatDate(report.appointmentAt || report.nextCallAt)}</td>
                  <td>
                    {report.recordingConsent ? (
                      report.recordingUrl ? (
                        <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                          <a href={`/api/reports/recording?url=${encodeURIComponent(report.recordingUrl)}`} target="_blank" rel="noreferrer">Abspielen</a>
                          <a href={`/api/reports/recording?url=${encodeURIComponent(report.recordingUrl)}&download=1`} download>↓</a>
                          <button
                            className="btn danger"
                            style={{ fontSize: "0.78rem", padding: "3px 9px" }}
                            onClick={() => void deleteRecording(report.id)}
                            disabled={busy}
                            title="Aufnahme löschen"
                          >✕</button>
                        </div>
                      ) : "Zugestimmt"
                    ) : (
                      "Keine Freigabe"
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <button
                        className="btn ghost"
                        style={{ fontSize: "0.82rem", padding: "5px 10px", whiteSpace: "nowrap" }}
                        onClick={() => setSelectedReport(report)}
                      >Details</button>
                      <button
                        className="btn danger"
                        style={{ fontSize: "0.82rem", padding: "5px 10px", whiteSpace: "nowrap" }}
                        onClick={() => void deleteReport(report.id)}
                        disabled={busy}
                        title="Report löschen"
                      >🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <article className="panel">
          <h2>Offene Firmenliste</h2>
          <table>
            <thead>
              <tr><th>Firma</th><th>Ansprechpartner</th><th>Thema</th><th>Status</th><th>Nächster Anruf</th></tr>
            </thead>
            <tbody>
              {data.leads.map((lead) => (
                <tr key={lead.id}>
                  <td><strong>{lead.company}</strong></td>
                  <td>{lead.contactName || "-"}</td>
                  <td>{lead.topic}</td>
                  <td>{lead.status}</td>
                  <td>{formatDate(lead.nextCallAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>

      {selectedReport && (() => {
        const conversationLines = buildConversationLines(selectedReport.summary || "");
        const lostStage = selectedReport.outcome !== "Termin" && selectedReport.outcome !== "Wiedervorlage"
          ? detectLostStage(selectedReport.summary || "")
          : null;

        return (
          <div className="modal-overlay" onClick={() => setSelectedReport(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedReport(null)}>✕</button>
              <h2>{selectedReport.company}</h2>
              <div className="row" style={{ marginTop: 8 }}>
                <span className={`status ${selectedReport.outcome === "Absage" ? "absage" : selectedReport.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                  {selectedReport.outcome}
                </span>
                <span className="subtle" style={{ fontSize: "0.85rem" }}>{formatDate(selectedReport.conversationDate)}</span>
              </div>

              <div className="report-detail-grid">
                <div className="report-detail-field">
                  <label>Ansprechpartner</label>
                  <p>{selectedReport.contactName || "–"}</p>
                </div>
                <div className="report-detail-field">
                  <label>Thema</label>
                  <p>{selectedReport.topic}</p>
                </div>
                <div className="report-detail-field">
                  <label>Gesprächsversuche</label>
                  <p>{selectedReport.attempts}</p>
                </div>
                <div className="report-detail-field">
                  <label>Aufnahme-Einwilligung</label>
                  <p>{selectedReport.recordingConsent ? "Ja" : "Nein"}</p>
                </div>

                {/* Outcome analysis */}
                <div className="report-detail-field report-detail-full">
                  <label>Gesprächsergebnis</label>
                  {selectedReport.outcome === "Termin" ? (
                    <p className="summary-box" style={{ background: "rgba(47,143,87,0.1)", borderColor: "rgba(47,143,87,0.3)" }}>
                      ✓ Termin vereinbart{selectedReport.appointmentAt ? ` am ${formatDate(selectedReport.appointmentAt)}` : ""}
                    </p>
                  ) : selectedReport.outcome === "Wiedervorlage" ? (
                    <p className="summary-box" style={{ background: "rgba(183,135,34,0.12)", borderColor: "rgba(183,135,34,0.3)" }}>
                      ⟳ Wiedervorlage{selectedReport.nextCallAt ? ` – nächster Anruf am ${formatDate(selectedReport.nextCallAt)}` : ""}
                    </p>
                  ) : selectedReport.outcome === "Absage" ? (
                    <p className="summary-box" style={{ background: "rgba(194,77,77,0.1)", borderColor: "rgba(194,77,77,0.3)" }}>
                      ✗ Absage — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  ) : (
                    <p className="summary-box" style={{ background: "rgba(100,120,160,0.08)", borderColor: "rgba(100,120,160,0.2)" }}>
                      – Kein Kontakt — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  )}
                </div>

                {/* Conversation flow */}
                {conversationLines.length > 0 && (
                  <div className="report-detail-field report-detail-full">
                    <label>Gesprächsverlauf</label>
                    <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                      {conversationLines.map((line, i) => (
                        <div
                          key={i}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 8,
                            fontSize: "0.88rem",
                            background: line.speaker === "Gloria" ? "rgba(43,101,217,0.07)" : "rgba(32,57,93,0.05)",
                            borderLeft: `3px solid ${line.speaker === "Gloria" ? "var(--blue-500)" : "var(--gold-500)"}`,
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: "0.78rem", color: line.speaker === "Gloria" ? "var(--blue-600)" : "var(--gold-600)" }}>
                            {line.speaker}
                          </span>
                          <br />
                          {line.text}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedReport.callSid && (
                  <div className="report-detail-field">
                    <label>Call-SID</label>
                    <p style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "#4f6588" }}>{selectedReport.callSid}</p>
                  </div>
                )}
                <div className="report-detail-field">
                  <label>E-Mail-Report an</label>
                  <p>{selectedReport.emailedTo || "–"}</p>
                </div>

                {/* Recording */}
                {selectedReport.recordingConsent && (
                  <div className="report-detail-field report-detail-full">
                    <label>Aufnahme</label>
                    {selectedReport.recordingUrl ? (
                      <div className="row top-gap">
                        <a
                          href={`/api/reports/recording?url=${encodeURIComponent(selectedReport.recordingUrl)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn ghost"
                        >Abspielen</a>
                        <a
                          href={`/api/reports/recording?url=${encodeURIComponent(selectedReport.recordingUrl)}&download=1`}
                          download
                          className="btn ghost"
                        >↓ Herunterladen</a>
                        <button
                          className="btn danger"
                          onClick={() => void deleteRecording(selectedReport.id)}
                          disabled={busy}
                        >Aufnahme löschen</button>
                      </div>
                    ) : (
                      <p className="subtle" style={{ marginTop: 6 }}>Keine Aufnahme vorhanden.</p>
                    )}
                  </div>
                )}

                {/* Delete whole report */}
                <div className="report-detail-field report-detail-full" style={{ borderTop: "1px solid var(--mist-200)", paddingTop: 14, marginTop: 4 }}>
                  <button
                    className="btn danger"
                    onClick={() => void deleteReport(selectedReport.id)}
                    disabled={busy}
                  >Report komplett löschen</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </main>
  );
}
