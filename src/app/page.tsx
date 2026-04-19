"use client";

import { useEffect, useMemo, useState, useRef } from "react";
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
      {/* Ende Accordion-Stack */}
    );
}

// Methoden außerhalb des return, aber innerhalb der Komponente
// (direkt nach den useState-Hooks und vor dem return platzieren)

// ...EXISTIERENDE useState und Hilfsfunktionen...

// Methoden:
// (1) createManualAppointment
// (2) deleteRecording
// (3) deleteReport

// 1. createManualAppointment
async function createManualAppointment() {
  if (!manualAppointment.company.trim()) {
    setNotice("Bitte zuerst eine Firma für den Termin eintragen.");
    return;
  }
  if (!manualAppointment.appointmentAt.trim()) {
    setNotice("Bitte Datum und Uhrzeit für den Termin auswählen.");
    return;
  }
  setBusy(true);
  try {
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualAppointment),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "Termin konnte nicht angelegt werden.");
    }
    setNotice("Termin wurde im Kalender und Report-Bereich gespeichert.");
    setManualAppointment((current) => ({
      ...current,
      company: "",
      contactName: "",
      summary: "",
    }));
    await loadDashboard();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Termin speichern fehlgeschlagen.");
  } finally {
    setBusy(false);
  }
}

// 2. deleteRecording
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

// 3. deleteReport
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

    return map;
  }, [appointmentReports]);

  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // Monday=0
    const start = new Date(firstOfMonth);
    start.setDate(firstOfMonth.getDate() - firstWeekday);

    return Array.from({ length: 42 }).map((_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = toDateKey(day);
      return {
        key,
        date: day,
        inMonth: day.getMonth() === calendarMonth.getMonth(),
        items: appointmentsByDay.get(key) || [],
      };
    });
  }, [appointmentsByDay, calendarMonth]);

  const selectedDayAppointments = useMemo(
    () => appointmentsByDay.get(selectedDayKey) || [],
    [appointmentsByDay, selectedDayKey],
  );

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
          recordingConsentLine: pickText(
            script.recordingConsentLine,
            'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".',
          ),
          healthCheckQuestions: pickText(
            script.healthCheckQuestions,
            "Bei Gesundheitsthemen bitte konkret fragen: gesetzlich/privat versichert, laufende/geplante Behandlungen, regelmäßige Medikamente und bekannte Diagnosen der letzten 5 Jahre.",
          ),
          appointmentTransition: pickText(
            script.appointmentTransition,
            "Nach bestätigtem Interesse kurz Nutzen zusammenfassen und direkt mit zwei konkreten Terminvorschlägen in die Terminierung überleiten.",
          ),
          appointmentSchedulingRules: pickText(
            script.appointmentSchedulingRules,
            "Nenne immer zwei konkrete Optionen in der nächsten Woche mit Datum und Uhrzeit. Wenn beides nicht passt, aktiv einen Alternativtermin mit Datum und Uhrzeit erfragen und bestätigen.",
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
      let csvContent = csvText;
      // Wenn Datei hochgeladen wurde, lese sie aus
      if (csvFile) {
        csvContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = (e) => reject(e);
          reader.readAsText(csvFile);
        });
      }
      const response = await fetch("/api/campaigns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: csvContent }),
      });
      const payload = (await response.json()) as { imported?: number; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "CSV konnte nicht importiert werden.");
      }
      setNotice(`CSV importiert: ${payload.imported ?? 0} neue Firmen in Gloria geladen.`);
      setCsvFile(null);
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

        {/* Accordion-Bereiche, vertikal untereinander */}
        <div className="accordion-stack" style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 0 }}>
          <Accordion title="Compliance & Ablauf" defaultOpen>
            <ul>
              <li><strong>Offenlegung:</strong> Gloria stellt sich immer als digitale Vertriebsassistentin der Agentur Duic Sprockhövel vor.</li>
              <li><strong>Aufzeichnung:</strong> Die Aufnahmefreigabe wird immer vor dem eigentlichen Gespräch klar und eindeutig abgefragt. Ohne Zustimmung keine Aufnahme.</li>
              <li><strong>Datenschutz:</strong> Alle Gesprächsdaten und Aufnahmen werden ausschließlich für Schulungs- und Qualitätszwecke verwendet und DSGVO-konform gespeichert.</li>
              <li><strong>Gesprächsziele:</strong> Mögliche Ausgänge sind Terminvereinbarung, Wiedervorlage (Rückruf) oder klare Absage.</li>
              <li><strong>Transparenz:</strong> Gesprächsreports und Aufnahmen sind jederzeit im Dashboard einsehbar.</li>
              <li><strong>Webhook für Telefonie:</strong> /api/calls/webhook</li>
              <li><strong>Technischer Ablauf:</strong> Jeder Anruf wird in einzelne Gesprächsrunden unterteilt, KI-gestützt analysiert und dokumentiert.</li>
              <li><strong>Protokollierung:</strong> Alle Aktionen und Gesprächsphasen werden nachvollziehbar protokolliert.</li>
              <li><strong>Rechte:</strong> Nur berechtigte Nutzer haben Zugriff auf Reports und Aufnahmen.</li>
            </ul>
          </Accordion>

          <Accordion title="Aufträge per CSV/Excel laden">
            <p className="subtle">Lade eine CSV- oder Excel-Datei mit Firmen auftraggebern hoch. Format: company, contactName, phone, email, topic, note, nextCallAt</p>
            <input
              type="file"
              accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                setCsvFile(file);
                if (!file) return;
                if (file.name.endsWith(".csv")) {
                  // CSV kann direkt gelesen werden
                  const reader = new FileReader();
                  reader.onload = (ev) => setCsvText(ev.target?.result as string);
                  reader.readAsText(file);
                } else {
                  // Excel: Hinweis
                  setCsvText("Excel-Import wird noch nicht direkt unterstützt. Bitte als CSV speichern und erneut hochladen.");
                }
              }}
              style={{ marginBottom: 8 }}
            />
            <textarea
              value={csvText}
              onChange={(event) => setCsvText(event.target.value)}
              style={{ width: "100%", minHeight: 80, marginBottom: 8 }}
              placeholder="CSV-Inhalt anzeigen oder bearbeiten..."
            />
            <div className="row top-gap">
              <button className="btn" onClick={() => void handleCsvImport()} disabled={busy}>CSV importieren</button>
              <button className="btn ghost" onClick={downloadSampleCsv}>Muster-CSV herunterladen</button>
            </div>
            <p className="subtle" style={{ marginTop: 8 }}>
              Nach dem Import werden alle Firmen automatisch in die <strong>Offene Firmenliste</strong> übernommen.
            </p>
          </Accordion>

          <Accordion title="Anruf Einzelfirma">
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
                <label>Ansprechpartner (Vorname + Nachname)</label>
                <input
                  value={twilioContactName}
                  onChange={(event) => setTwilioContactName(event.target.value)}
                  placeholder="z. B. Max Neumann"
                />
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
                {busy ? "Anruf startet ..." : "Testanruf starten"}
              </button>
            </div>
          </Accordion>

          <Accordion title="Gloria testen">
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
          </Accordion>

          <Accordion title="Gloria lernt aus Gesprächen">
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
          </Accordion>
        </div>
      {/* Ende Accordion-Stack */}
    );
  // Methoden ab hier wieder innerhalb der Komponente, aber außerhalb des return-Blocks

  async function createManualAppointment() {
    if (!manualAppointment.company.trim()) {
      setNotice("Bitte zuerst eine Firma für den Termin eintragen.");
      return;
    }

    if (!manualAppointment.appointmentAt.trim()) {
      setNotice("Bitte Datum und Uhrzeit für den Termin auswählen.");
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(manualAppointment),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Termin konnte nicht angelegt werden.");
      }

      setNotice("Termin wurde im Kalender und Report-Bereich gespeichert.");
      setManualAppointment((current) => ({
        ...current,
        company: "",
        contactName: "",
        summary: "",
      }));
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Termin speichern fehlgeschlagen.");
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
                <label>Ansprechpartner (Vorname + Nachname)</label>
                <input
                  value={twilioContactName}
                  onChange={(event) => setTwilioContactName(event.target.value)}
                  placeholder="z. B. Max Neumann"
                />
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
            <label>Aufzeichnungserlaubnis (inkl. klare JA/NEIN-Antwort anfordern)</label>
            <textarea value={activeDraft.recordingConsentLine ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], recordingConsentLine: event.target.value } }))} />
            <label>Gesundheitsfragen (konkrete Fragen statt nur "grundsätzlich gesund")</label>
            <textarea value={activeDraft.healthCheckQuestions ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], healthCheckQuestions: event.target.value } }))} />
            <label>Überleitung in die Terminierung</label>
            <textarea value={activeDraft.appointmentTransition ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], appointmentTransition: event.target.value } }))} />
            <label>Terminierungsregeln (Datum + Uhrzeit + Alternative erfragen)</label>
            <textarea value={activeDraft.appointmentSchedulingRules ?? ""} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], appointmentSchedulingRules: event.target.value } }))} />

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

      <section className="panel top-section">
        <div className="row spread">
          <h2>Terminkalender</h2>
          <div className="row">
            <button
              className="btn ghost"
              onClick={() =>
                setCalendarMonth(
                  (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1),
                )
              }
            >
              ← Monat zurück
            </button>
            <strong>
              {new Intl.DateTimeFormat("de-DE", {
                month: "long",
                year: "numeric",
              }).format(calendarMonth)}
            </strong>
            <button
              className="btn ghost"
              onClick={() =>
                setCalendarMonth(
                  (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
                )
              }
            >
              Monat vor →
            </button>
          </div>
        </div>

        <div className="calendar-grid top-gap">
          {[
            "Mo",
            "Di",
            "Mi",
            "Do",
            "Fr",
            "Sa",
            "So",
          ].map((weekday) => (
            <div key={weekday} className="calendar-weekday">{weekday}</div>
          ))}
          {calendarDays.map((day) => {
            const isSelected = day.key === selectedDayKey;
            return (
              <button
                key={day.key}
                className={`calendar-day ${day.inMonth ? "" : "outside"} ${isSelected ? "selected" : ""}`}
                onClick={() => setSelectedDayKey(day.key)}
              >
                <span>{day.date.getDate()}</span>
                <small>{day.items.length > 0 ? `${day.items.length} Termin(e)` : "-"}</small>
              </button>
            );
          })}
        </div>

        <div className="calendar-detail top-gap">
          <div className="mini-panel">
            <h3>
              Termine am {new Intl.DateTimeFormat("de-DE", { dateStyle: "full" }).format(new Date(selectedDayKey))}
            </h3>
            {selectedDayAppointments.length > 0 ? (
              <div className="calendar-list top-gap">
                {selectedDayAppointments.map((report) => (
                  <button
                    key={report.id}
                    className="calendar-item"
                    onClick={() => setSelectedReport(report)}
                  >
                    <strong>{formatDate(report.appointmentAt)}</strong>
                    <span>{report.company}{report.contactName ? ` · ${report.contactName}` : ""}</span>
                    <small>{report.topic}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="subtle top-gap">Für diesen Tag sind noch keine Termine eingetragen.</p>
            )}
          </div>

          <div className="mini-panel">
            <h3>Termin direkt eintragen</h3>
            <div className="field-grid top-gap">
              <div>
                <label>Firma</label>
                <input
                  value={manualAppointment.company}
                  onChange={(event) =>
                    setManualAppointment((current) => ({ ...current, company: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>Ansprechpartner</label>
                <input
                  value={manualAppointment.contactName}
                  onChange={(event) =>
                    setManualAppointment((current) => ({ ...current, contactName: event.target.value }))
                  }
                />
              </div>
              <div>
                <label>Thema</label>
                <select
                  value={manualAppointment.topic}
                  onChange={(event) =>
                    setManualAppointment((current) => ({ ...current, topic: event.target.value as Topic }))
                  }
                >
                  {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                </select>
              </div>
              <div>
                <label>Datum & Uhrzeit</label>
                <input
                  type="datetime-local"
                  value={manualAppointment.appointmentAt}
                  onChange={(event) =>
                    setManualAppointment((current) => ({ ...current, appointmentAt: event.target.value }))
                  }
                />
              </div>
            </div>
            <label>Notiz</label>
            <textarea
              value={manualAppointment.summary}
              onChange={(event) =>
                setManualAppointment((current) => ({ ...current, summary: event.target.value }))
              }
              style={{ minHeight: 80 }}
            />
            <div className="row top-gap">
              <button className="btn" onClick={() => void createManualAppointment()} disabled={busy}>
                {busy ? "Speichert ..." : "Termin speichern"}
              </button>
              <a className="btn ghost" href="/api/export/outlook">Outlook-CSV exportieren</a>
            </div>
          </div>
        </div>
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
                            background:
                              line.speaker === "Phase"
                                ? "rgba(183,135,34,0.14)"
                                : line.speaker === "Gloria"
                                  ? "rgba(43,101,217,0.07)"
                                  : "rgba(32,57,93,0.05)",
                            borderLeft: `3px solid ${
                              line.speaker === "Phase"
                                ? "var(--gold-600)"
                                : line.speaker === "Gloria"
                                  ? "var(--blue-500)"
                                  : "var(--gold-500)"
                            }`,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: "0.78rem",
                              color:
                                line.speaker === "Phase"
                                  ? "#8a5e18"
                                  : line.speaker === "Gloria"
                                    ? "var(--blue-600)"
                                    : "var(--gold-600)",
                            }}
                          >
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
