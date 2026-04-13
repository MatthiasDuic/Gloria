"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BAV_TERMINIERUNG_SCRIPT,
  BKV_TERMINIERUNG_SCRIPT,
  ENERGIE_TERMINIERUNG_SCRIPT,
  GEWERBE_TERMINIERUNG_SCRIPT,
  PKV_TERMINIERUNG_SCRIPT,
} from "@/lib/call-scripts";
import type { CallScript } from "@/lib/call-scripts";
import { buildLiveAgentConfig } from "@/lib/live-agent";
import type { DashboardData, LearningResponse, ScriptConfig, Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";

const SAMPLE_CSV = `company,contactName,phone,email,topic,note,nextCallAt
Musterbau GmbH,Herr Neumann,+49 2339 555100,neumann@musterbau.de,betriebliche Krankenversicherung,120 Mitarbeitende; Recruiting Thema,
Sprockhoevel Energieberatung,Frau Peters,+49 2324 555200,peters@se-beratung.de,Energie,Vertragsverlängerung in 90 Tagen,2026-04-15T10:00:00.000Z`;

const EMPTY_DATA: DashboardData = {
  leads: [],
  reports: [],
  scripts: [],
  metrics: {
    dialAttempts: 0,
    conversations: 0,
    appointments: 0,
    rejections: 0,
    callbacksOpen: 0,
  },
};

const EMPTY_LEARNING: LearningResponse = {
  insights: [],
  globalSummary: [],
};

const DETAIL_SCRIPTS: Record<Topic, CallScript> = {
  "betriebliche Krankenversicherung": BKV_TERMINIERUNG_SCRIPT,
  "betriebliche Altersvorsorge": BAV_TERMINIERUNG_SCRIPT,
  "gewerbliche Versicherungen": GEWERBE_TERMINIERUNG_SCRIPT,
  "private Krankenversicherung": PKV_TERMINIERUNG_SCRIPT,
  Energie: ENERGIE_TERMINIERUNG_SCRIPT,
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

function buildLocalVoicePreview(script?: ScriptConfig) {
  if (!script) {
    return "";
  }

  return [script.opener, script.discovery, script.objectionHandling, script.close]
    .filter(Boolean)
    .join(" ");
}

function formatScriptText(text?: string) {
  if (!text) {
    return "-";
  }

  return text.trim().replace(/\n\s+/g, "\n");
}

export default function HomePage() {
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [voiceTopic, setVoiceTopic] = useState<Topic>(TOPICS[0]);
  const [detailTopic, setDetailTopic] = useState<Topic>(TOPICS[0]);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceAudioUrl, setVoiceAudioUrl] = useState("");
  const [voiceProvider, setVoiceProvider] = useState("browser");
  const [learning, setLearning] = useState<LearningResponse>(EMPTY_LEARNING);
  const [prospectMessage, setProspectMessage] = useState(
    "Wir haben aktuell eigentlich kein Interesse und außerdem wenig Zeit.",
  );
  const [liveReply, setLiveReply] = useState("");
  const [liveMode, setLiveMode] = useState("openai");
  const [twilioTarget, setTwilioTarget] = useState("");
  const [twilioCompany, setTwilioCompany] = useState("Musterbau GmbH");
  const [twilioContactName, setTwilioContactName] = useState("Herr Neumann");
  const [twilioTopic, setTwilioTopic] = useState<Topic>(TOPICS[0]);
  const [notice, setNotice] = useState("Dashboard wird geladen ...");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draftScripts, setDraftScripts] = useState<Record<string, ScriptConfig>>({});

  const detailScript = DETAIL_SCRIPTS[detailTopic];
  const liveAgentConfig = buildLiveAgentConfig(detailTopic, draftScripts[detailTopic]);
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
        acc[script.topic] = script;
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

  async function saveScript(topic: Topic) {
    const draft = draftScripts[topic];

    if (!draft) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });

      if (!response.ok) {
        throw new Error("Skript konnte nicht gespeichert werden.");
      }

      setNotice(`Skript für ${topic} gespeichert.`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Speichern fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function applyLearning(topic: Topic) {
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

  async function testVoice() {
    setBusy(true);

    const localPreview = buildLocalVoicePreview(draftScripts[voiceTopic]);
    setVoicePreview(localPreview || "Vorschau wird geladen ...");
    setVoiceAudioUrl("");
    setVoiceProvider("browser");

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

      setVoicePreview(payload.preview || localPreview || "Keine Vorschau verfügbar.");
      setVoiceProvider(payload.provider || "browser");

      if (payload.audioBase64 && payload.audioMimeType) {
        const url = `data:${payload.audioMimeType};base64,${payload.audioBase64}`;
        setVoiceAudioUrl(url);
        void new Audio(url).play().catch(() => undefined);
      } else {
        setVoiceAudioUrl("");
        speakText(payload.preview || localPreview);
      }

      setNotice(payload.message || `Stimmtest für ${voiceTopic} gestartet.`);
    } catch (error) {
      if (localPreview) {
        setVoicePreview(localPreview);
      }

      setNotice(
        error instanceof Error
          ? `${error.message} - die Textvorschau wurde lokal geladen.`
          : "Stimmtest konnte nicht geladen werden - die Textvorschau wurde lokal geladen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function simulateLiveReplyResponse() {
    setBusy(true);

    try {
      const response = await fetch("/api/live-agent/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: detailTopic,
          prospectMessage,
          transcript: `Gloria hat bereits Kontakt aufgenommen und möchte einen Termin für ${detailTopic} vereinbaren.`,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        reply?: string;
        mode?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Live-Antwort konnte nicht erzeugt werden.");
      }

      setLiveReply(payload.reply || "Keine Antwort erzeugt.");
      setLiveMode(payload.mode || "openai");
      setNotice("OpenAI-Liveantwort erzeugt und auf Terminziel ausgerichtet.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Live-Antwort fehlgeschlagen.");
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
          <span className="pill">Reports an Matthias.duic@agentur-duic-sprockhoevel.de</span>
        </div>
      </header>

      <section className="stats-grid">
        <article className="stat-card"><span>Wählversuche</span><strong>{data.metrics.dialAttempts}</strong></article>
        <article className="stat-card"><span>Gespräche</span><strong>{data.metrics.conversations}</strong></article>
        <article className="stat-card"><span>Termine</span><strong>{data.metrics.appointments}</strong></article>
        <article className="stat-card"><span>Absagen</span><strong>{data.metrics.rejections}</strong></article>
        <article className="stat-card"><span>Wiedervorlagen offen</span><strong>{data.metrics.callbacksOpen}</strong></article>
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
            <p className="subtle top-gap">Aktive Quelle: <strong>{voiceProvider === "elevenlabs" ? "ElevenLabs" : "Browser"}</strong></p>
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
                  <button className="btn ghost" onClick={() => void applyLearning(insight.topic)} disabled={busy}>Optimierung anwenden</button>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="panel top-section">
        <h2>Live-KI (OpenAI): frei reagieren und trotzdem zum Ziel kommen</h2>
        <div className="live-grid">
          <div className="mini-panel">
            <h3>Zielsteuerung für {detailTopic}</h3>
            <p className="subtle">Primäres Ziel</p>
            <div className="code-box">{liveAgentConfig.objective}</div>
            <p className="subtle top-gap">Erster Gesprächseinstieg</p>
            <div className="code-box">{formatScriptText(liveAgentConfig.firstMessage)}</div>
          </div>
          <div className="mini-panel">
            <h3>Freie Antwort simulieren</h3>
            <textarea value={prospectMessage} onChange={(event) => setProspectMessage(event.target.value)} />
            <div className="row top-gap">
              <button className="btn" onClick={() => void simulateLiveReplyResponse()} disabled={busy}>
                {busy ? "OpenAI antwortet ..." : "Freie Antwort testen"}
              </button>
            </div>
            <p className="subtle top-gap">Aktiver Modus: <strong>{liveMode}</strong></p>
            <div className="code-box">{liveReply || "Noch keine Live-Antwort simuliert."}</div>
          </div>
        </div>
      </section>

      <section className="panel top-section">
        <div className="row spread">
          <h2>Detail-Skripte und Bearbeitung</h2>
          <select value={detailTopic} onChange={(event) => setDetailTopic(event.target.value as Topic)}>
            {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
          </select>
        </div>

        <div className="live-grid">
          <div className="mini-panel">
            <h3>{detailScript.title}</h3>
            <p className="subtle">Empfang</p>
            <div className="code-box">{formatScriptText(detailScript.reception.intro)}</div>
            <p className="subtle top-gap">Entscheider-Einstieg</p>
            <div className="code-box">{formatScriptText(detailScript.intro.text)}</div>
            <p className="subtle top-gap">Problem/Nutzen</p>
            <div className="code-box">{formatScriptText(detailScript.problem.text)}</div>
            <p className="subtle top-gap">Abschluss</p>
            <div className="code-box">{formatScriptText(detailScript.close.main)}</div>
          </div>

          <div className="mini-panel">
            <h3>Skript-Editor ({detailTopic})</h3>
            {activeDraft ? (
              <>
                <label>Opener</label>
                <textarea
                  value={activeDraft.opener}
                  onChange={(event) =>
                    setDraftScripts((current) => ({
                      ...current,
                      [detailTopic]: { ...current[detailTopic], opener: event.target.value },
                    }))
                  }
                />
                <label>Bedarfsermittlung</label>
                <textarea
                  value={activeDraft.discovery}
                  onChange={(event) =>
                    setDraftScripts((current) => ({
                      ...current,
                      [detailTopic]: { ...current[detailTopic], discovery: event.target.value },
                    }))
                  }
                />
                <label>Einwandbehandlung</label>
                <textarea
                  value={activeDraft.objectionHandling}
                  onChange={(event) =>
                    setDraftScripts((current) => ({
                      ...current,
                      [detailTopic]: { ...current[detailTopic], objectionHandling: event.target.value },
                    }))
                  }
                />
                <label>Terminabschluss</label>
                <textarea
                  value={activeDraft.close}
                  onChange={(event) =>
                    setDraftScripts((current) => ({
                      ...current,
                      [detailTopic]: { ...current[detailTopic], close: event.target.value },
                    }))
                  }
                />
                <div className="row top-gap">
                  <button className="btn" onClick={() => void saveScript(detailTopic)} disabled={busy}>Skript speichern</button>
                </div>
              </>
            ) : (
              <p className="subtle">Für dieses Thema liegt noch kein editierbares Skript vor.</p>
            )}
          </div>
        </div>
      </section>

      <section className="report-grid top-section">
        <article className="panel">
          <h2>Gesprächsreports & Aufnahmen</h2>
          <table>
            <thead>
              <tr><th>Firma</th><th>Thema</th><th>Ergebnis</th><th>Termin / Callback</th><th>Aufnahme</th></tr>
            </thead>
            <tbody>
              {reportRows.map((report) => (
                <tr key={report.id}>
                  <td><strong>{report.company}</strong><div className="subtle">{report.summary}</div></td>
                  <td>{report.topic}</td>
                  <td>
                    <span className={`status ${report.outcome === "Absage" ? "absage" : report.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                      {report.outcome}
                    </span>
                  </td>
                  <td>{formatDate(report.appointmentAt || report.nextCallAt)}</td>
                  <td>
                    {report.recordingConsent ? (
                      report.recordingUrl ? <a href={report.recordingUrl} target="_blank" rel="noreferrer">Audio öffnen</a> : "Zugestimmt"
                    ) : (
                      "Keine Freigabe"
                    )}
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
              <tr><th>Firma</th><th>Status</th><th>Nächster Anruf</th></tr>
            </thead>
            <tbody>
              {data.leads.map((lead) => (
                <tr key={lead.id}>
                  <td><strong>{lead.company}</strong><div className="subtle">{lead.topic}</div></td>
                  <td>{lead.status}</td>
                  <td>{formatDate(lead.nextCallAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </main>
  );
}
