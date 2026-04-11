"use client";

import { useEffect, useState } from "react";
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
  const [liveMode, setLiveMode] = useState("rule-based");
  const [twilioTarget, setTwilioTarget] = useState("");
  const [twilioCompany, setTwilioCompany] = useState("Musterbau GmbH");
  const [twilioContactName, setTwilioContactName] = useState("Herr Neumann");
  const [twilioTopic, setTwilioTopic] = useState<Topic>(TOPICS[0]);
  const [notice, setNotice] = useState("Dashboard wird geladen …");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draftScripts, setDraftScripts] = useState<Record<string, ScriptConfig>>({});
  const detailScript = DETAIL_SCRIPTS[detailTopic];
  const liveAgentConfig = buildLiveAgentConfig(detailTopic, draftScripts[detailTopic]);

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
      const payload = (await response.json()) as { error?: string; recommendations?: string[] };

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
    setVoicePreview(localPreview || "Vorschau wird geladen …");
    setVoiceAudioUrl("");
    setVoiceProvider("browser");
    setNotice(`Vorschau für ${voiceTopic} wird geladen …`);

    try {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: voiceTopic }),
      });

      const raw = await response.text();
      const payload = JSON.parse(raw) as {
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
          ? `${error.message} – die Textvorschau wurde lokal geladen.`
          : "Stimmtest konnte nicht geladen werden – die Textvorschau wurde lokal geladen.",
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
      setLiveMode(payload.mode || "rule-based");
      setNotice(`Gloria reagiert jetzt frei auf ${detailTopic} und bleibt auf dem Termin-Ziel.`);
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
    <main className="page">
      <section className="hero">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <span className="badge">Gloria – digitale Vertriebsassistentin</span>
            <h1>KI-Akquise-Dashboard für Herrn Duic</h1>
            <p>
              Gloria ruft im Auftrag von Herrn Matthias Duic an, erkennt sich direkt als
              digitale Assistentin zu erkennen und fragt zu Beginn immer nach der
              Erlaubnis zur Aufzeichnung. Danach arbeitet sie zielorientiert auf einen
              Termin oder eine Wiedervorlage hin.
            </p>
          </div>
          <a className="button-link secondary" href="/api/export/outlook">
            Outlook-CSV exportieren
          </a>
        </div>
        <p className="callout">
          Reports und – bei Zustimmung – Aufnahmelinks gehen an
          <strong> Matthias.duic@agentur-duic-sprockhoevel.de</strong>.
        </p>
        <p className="kpi-note">{loading ? "Lade Daten …" : notice}</p>
      </section>

      <section className="grid">
        <div className="panel metric">
          Wählversuche
          <strong>{data.metrics.dialAttempts}</strong>
        </div>
        <div className="panel metric">
          Gespräche
          <strong>{data.metrics.conversations}</strong>
        </div>
        <div className="panel metric">
          Termine
          <strong>{data.metrics.appointments}</strong>
        </div>
        <div className="panel metric">
          Absagen
          <strong>{data.metrics.rejections}</strong>
        </div>
        <div className="panel metric">
          Wiedervorlagen offen
          <strong>{data.metrics.callbacksOpen}</strong>
        </div>
      </section>

      <section className="section">
        <div className="stack">
          <div className="panel">
            <h2>Aufträge per CSV laden</h2>
            <p className="subtle">
              Format: <code>company, contactName, phone, email, topic, note, nextCallAt</code>
            </p>
            <textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} />
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => void handleCsvImport()} disabled={busy}>
                CSV importieren
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>Gloria testen</h2>
            <p className="subtle">
              Wenn `ELEVENLABS_API_KEY` und `ELEVENLABS_VOICE_ID` gesetzt sind, nutzt Gloria
              hier deine echte ElevenLabs-Stimme. Sonst wird automatisch die Browser-Stimme als
              Fallback verwendet.
            </p>
            <div className="row">
              <select value={voiceTopic} onChange={(event) => setVoiceTopic(event.target.value as Topic)}>
                {TOPICS.map((topic) => (
                  <option key={topic} value={topic}>
                    {topic}
                  </option>
                ))}
              </select>
              <button onClick={() => void testVoice()} disabled={busy}>
                {busy ? "Vorschau lädt …" : "Stimme testen"}
              </button>
            </div>
            <div className="code" style={{ marginTop: 12 }}>
              {voicePreview || "Noch keine Vorschau geladen."}
            </div>
            <p className="subtle" style={{ marginTop: 10 }}>
              Aktive Quelle: <strong>{voiceProvider === "elevenlabs" ? "ElevenLabs" : "Browser-Fallback"}</strong>
            </p>
            {voiceAudioUrl ? (
              <audio controls src={voiceAudioUrl} style={{ marginTop: 10, width: "100%" }}>
                Dein Browser unterstützt kein Audio-Element.
              </audio>
            ) : null}
          </div>

          <div className="panel">
            <h2>Twilio Live-Testanruf</h2>
            <p className="subtle">
              Sobald `APP_BASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` und
              `TWILIO_PHONE_NUMBER` in `.env.local` gesetzt sind, kann Gloria hier einen
              echten Testanruf über deinen Twilio-Account starten. Wenn zusätzlich ElevenLabs
              konfiguriert ist, wird dabei automatisch Glorias ElevenLabs-Stimme abgespielt.
            </p>
            <div className="grid">
              <div>
                <label>Zielnummer</label>
                <input
                  value={twilioTarget}
                  onChange={(event) => setTwilioTarget(event.target.value)}
                  placeholder="+492339123456"
                />
              </div>
              <div>
                <label>Firma</label>
                <input value={twilioCompany} onChange={(event) => setTwilioCompany(event.target.value)} />
              </div>
              <div>
                <label>Ansprechpartner</label>
                <input
                  value={twilioContactName}
                  onChange={(event) => setTwilioContactName(event.target.value)}
                />
              </div>
              <div>
                <label>Thema</label>
                <select value={twilioTopic} onChange={(event) => setTwilioTopic(event.target.value as Topic)}>
                  {TOPICS.map((topic) => (
                    <option key={topic} value={topic}>
                      {topic}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => void startTwilioTestCall()} disabled={busy || !twilioTarget.trim()}>
                {busy ? "Anruf startet …" : "Twilio-Testanruf starten"}
              </button>
            </div>
            <p className="subtle" style={{ marginTop: 10 }}>
              Für lokale Tests brauchst du zusätzlich eine öffentliche URL, z. B. per
              `cloudflared tunnel --url http://localhost:3000` oder `ngrok http 3000`.
            </p>
          </div>
        </div>

        <div className="panel">
          <h2>Compliance & Ablauf</h2>
          <ul>
            <li>Direkte Offenlegung: „Ich bin Gloria, die digitale Vertriebsassistentin …“</li>
            <li>Immer zu Beginn Aufnahmeerlaubnis abfragen</li>
            <li>Nur Termin, Absage oder Wiedervorlage als klares Ergebnis akzeptieren</li>
            <li>Wiedervorlagen werden mit Termin gespeichert und erneut angerufen</li>
            <li>Webhook für Telefonie: <code>/api/calls/webhook</code></li>
          </ul>
          <p className="subtle">
            Themen: bKV, bAV, gewerbliche Versicherungen, PKV sowie Strom & Gas für
            Gewerbekunden.
          </p>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 18 }}>
        <h2>Live-KI: frei reagieren und trotzdem zum Ziel kommen</h2>
        <p className="subtle">
          Gloria ist jetzt auf einen echten Gesprächsmodus vorbereitet: Sie darf auf freie Aussagen,
          Rückfragen und unerwartete Einwände reagieren – führt das Gespräch aber immer wieder
          aktiv Richtung Termin, Wiedervorlage oder richtiger Ansprechpartner zurück.
        </p>

        <div className="grid">
          <div className="panel" style={{ background: "#0b1422" }}>
            <h3>Zielsteuerung für {detailTopic}</h3>
            <p className="subtle">Primäres Ziel</p>
            <div className="code">{liveAgentConfig.objective}</div>
            <p className="subtle" style={{ marginTop: 12 }}>Erster Gesprächseinstieg</p>
            <div className="code">{formatScriptText(liveAgentConfig.firstMessage)}</div>
            <p className="subtle" style={{ marginTop: 12 }}>Erfolgskriterien</p>
            <ul>
              {liveAgentConfig.successCriteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="subtle">Wichtige Vorqualifikation</p>
            <ul>
              {liveAgentConfig.qualificationFields.slice(0, 6).map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </div>

          <div className="panel" style={{ background: "#0b1422" }}>
            <h3>Freie Antwort simulieren</h3>
            <p className="subtle">
              Teste hier, wie Gloria auf Aussagen reagiert, die nicht 1:1 im Skript stehen.
            </p>
            <textarea value={prospectMessage} onChange={(event) => setProspectMessage(event.target.value)} />
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => void simulateLiveReplyResponse()} disabled={busy}>
                {busy ? "KI antwortet …" : "Freie Antwort testen"}
              </button>
            </div>
            <p className="subtle" style={{ marginTop: 12 }}>
              Aktiver Modus: <strong>{liveMode}</strong>
            </p>
            <div className="code">{liveReply || "Noch keine Live-Antwort simuliert."}</div>
          </div>
        </div>

        <div className="panel" style={{ background: "#0b1422", marginTop: 12 }}>
          <h3>Rückführung zum Ziel</h3>
          <ul>
            {liveAgentConfig.recoveryPlaybook.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 18 }}>
        <h2>Gloria lernt aus Gesprächen</h2>
        <p className="subtle">
          Jeder Gesprächsreport fließt in eine laufende Optimierungslogik ein. Gloria erkennt,
          welche Nutzenargumente ziehen, wo Wiedervorlagen entstehen und welche Abschlüsse
          besser funktionieren.
        </p>
        <ul>
          {learning.globalSummary.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="grid">
          {learning.insights.map((insight) => (
            <div key={insight.topic} className="panel" style={{ background: "#0b1422" }}>
              <h3>{insight.topic}</h3>
              <div className="row">
                <span className="badge">{insight.appointmentRate}% Terminquote</span>
                <span className="badge">{insight.totalConversations} Gespräche</span>
                <span className="badge">{insight.callbacks} Wiedervorlagen</span>
              </div>
              <p className="subtle" style={{ marginTop: 12 }}>Lernsignale</p>
              <ul>
                {insight.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
              <p className="subtle">Empfohlene Verbesserung</p>
              <ul>
                {insight.recommendations.map((recommendation) => (
                  <li key={recommendation}>{recommendation}</li>
                ))}
              </ul>
              <div className="code">Nächster Terminabschluss: {insight.optimizedScript.close}</div>
              <div className="row" style={{ marginTop: 12 }}>
                <button onClick={() => void applyLearning(insight.topic)} disabled={busy}>
                  Optimierung anwenden
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 18 }}>
        <h2>Detail-Skripte direkt im Dashboard</h2>
        <p className="subtle">
          Hier findest du für jede Sparte den vollständigen Gesprächsleitfaden für Empfang,
          Entscheider, Bedarfsermittlung, Einwandbehandlung und Terminierung – direkt nutzbar
          für Gloria und dein Team.
        </p>

        <div className="row" style={{ marginBottom: 12 }}>
          <select value={detailTopic} onChange={(event) => setDetailTopic(event.target.value as Topic)}>
            {TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {topic}
              </option>
            ))}
          </select>
        </div>

        <div className="panel" style={{ background: "#0b1422" }}>
          <h3>{detailScript.title}</h3>
          <div className="grid">
            <div>
              <p className="subtle">Empfang / Zentrale</p>
              <div className="code">{formatScriptText(detailScript.reception.intro)}</div>
            </div>
            <div>
              <p className="subtle">Entscheider-Einstieg</p>
              <div className="code">{formatScriptText(detailScript.intro.text)}</div>
            </div>
            <div>
              <p className="subtle">Problem / Nutzen</p>
              <div className="code">{formatScriptText(detailScript.problem.text)}</div>
            </div>
            <div>
              <p className="subtle">Konzept & Terminabschluss</p>
              <div className="code">
                {formatScriptText(detailScript.concept.text)}
                {"\n\n"}
                {formatScriptText(detailScript.close.main)}
              </div>
            </div>
          </div>

          <div className="grid" style={{ marginTop: 12 }}>
            <div>
              <p className="subtle">Wenn Empfang nach dem Thema fragt</p>
              <div className="code">{formatScriptText(detailScript.reception.ifAskedWhatTopic)}</div>
            </div>
            <div>
              <p className="subtle">Alternative Kurzform</p>
              <div className="code">{formatScriptText(detailScript.reception.alternativeShort)}</div>
            </div>
            <div>
              <p className="subtle">Wenn auf E-Mail verwiesen wird</p>
              <div className="code">{formatScriptText(detailScript.reception.ifEmailSuggested)}</div>
            </div>
            <div>
              <p className="subtle">Falls trotzdem nur E-Mail gewünscht ist</p>
              <div className="code">{formatScriptText(detailScript.reception.ifEmailInsisted)}</div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <p className="subtle">Bedarfsermittlung</p>
            <div className="stack">
              {detailScript.needs.questions.map((question, index) => (
                <div key={`${detailScript.id}-question-${index}`} className="code">
                  {formatScriptText(question)}
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <p className="subtle">Einwandlogiken</p>
            <div className="grid">
              {Object.entries(detailScript.objections).map(([objection, answer]) => (
                <div key={`${detailScript.id}-${objection}`} className="panel" style={{ background: "#08101b" }}>
                  <strong>{objection}</strong>
                  <div className="code" style={{ marginTop: 8 }}>{formatScriptText(answer)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid" style={{ marginTop: 12 }}>
            <div>
              <p className="subtle">Datenabfrage / Terminvorbereitung</p>
              <div className="code">{formatScriptText(detailScript.dataCollection.intro)}</div>
              <ul>
                {detailScript.dataCollection.fields.map((field) => (
                  <li key={`${detailScript.id}-${field}`}>{field}</li>
                ))}
              </ul>
              {detailScript.dataCollection.ifDetailsDeclined ? (
                <div className="code">{formatScriptText(detailScript.dataCollection.ifDetailsDeclined)}</div>
              ) : null}
            </div>
            <div>
              <p className="subtle">Abschluss</p>
              <div className="code">{formatScriptText(detailScript.final.text)}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 18 }}>
        <h2>Skripte bearbeiten</h2>
        <div className="stack">
          {TOPICS.map((topic) => {
            const draft = draftScripts[topic];

            if (!draft) {
              return null;
            }

            return (
              <div key={topic} className="panel" style={{ background: "#0b1422" }}>
                <h3>{topic}</h3>
                <div className="grid">
                  <div>
                    <label>Opener</label>
                    <textarea
                      value={draft.opener}
                      onChange={(event) =>
                        setDraftScripts((current) => ({
                          ...current,
                          [topic]: { ...current[topic], opener: event.target.value },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label>Bedarfsermittlung</label>
                    <textarea
                      value={draft.discovery}
                      onChange={(event) =>
                        setDraftScripts((current) => ({
                          ...current,
                          [topic]: { ...current[topic], discovery: event.target.value },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label>Einwandbehandlung</label>
                    <textarea
                      value={draft.objectionHandling}
                      onChange={(event) =>
                        setDraftScripts((current) => ({
                          ...current,
                          [topic]: {
                            ...current[topic],
                            objectionHandling: event.target.value,
                          },
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label>Terminabschluss</label>
                    <textarea
                      value={draft.close}
                      onChange={(event) =>
                        setDraftScripts((current) => ({
                          ...current,
                          [topic]: { ...current[topic], close: event.target.value },
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <button onClick={() => void saveScript(topic)} disabled={busy}>
                    Skript speichern
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <div className="panel">
          <h2>Gesprächsreports & Aufnahmen</h2>
          <table>
            <thead>
              <tr>
                <th>Firma</th>
                <th>Thema</th>
                <th>Ergebnis</th>
                <th>Termin / Callback</th>
                <th>Aufnahme</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    <strong>{report.company}</strong>
                    <div className="subtle">{report.summary}</div>
                  </td>
                  <td>{report.topic}</td>
                  <td>
                    <span
                      className={`status ${
                        report.outcome === "Absage"
                          ? "absage"
                          : report.outcome === "Wiedervorlage"
                            ? "wiedervorlage"
                            : ""
                      }`}
                    >
                      {report.outcome}
                    </span>
                  </td>
                  <td>{formatDate(report.appointmentAt || report.nextCallAt)}</td>
                  <td>
                    {report.recordingConsent ? (
                      report.recordingUrl ? (
                        <a href={report.recordingUrl} target="_blank" rel="noreferrer">
                          Audio öffnen
                        </a>
                      ) : (
                        "Zugestimmt"
                      )
                    ) : (
                      "Keine Freigabe"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Offene Firmenliste</h2>
          <table>
            <thead>
              <tr>
                <th>Firma</th>
                <th>Status</th>
                <th>Nächster Anruf</th>
              </tr>
            </thead>
            <tbody>
              {data.leads.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <strong>{lead.company}</strong>
                    <div className="subtle">{lead.topic}</div>
                  </td>
                  <td>{lead.status}</td>
                  <td>{formatDate(lead.nextCallAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
