# Gloria – KI-Assistentin für B2B-Neukundenakquise

Dieses Projekt erstellt eine **einsatzbereite Admin-Oberfläche** für `Gloria`, die digitale Vertriebsassistentin im Auftrag von **Herrn Matthias Duic**.

## 🚀 Produktionsstatus

| Status | Details |
|--------|---------|
| **Live** | https://gloria.agentur-duic-sprockhoevel.de |
| **Alias** | https://gloria-ki-assistant.vercel.app |
| **E2E Tests** | 14/14 bestanden (API-Sicherheit + Kampagnen-Flow) |
| **Deployment** | April 21, 2026 via Vercel |
| **Health Check** | `/api/health` → 200 OK |

Für Deployment-Details siehe [DEPLOYMENT.md](./DEPLOYMENT.md).

## Enthaltene Funktionen

- **CSV-basierte Aufträge** mit Firmenliste und Themen
- **bearbeitbare Skripte** für
  - betriebliche Krankenversicherung
  - betriebliche Altersvorsorge
  - gewerbliche Versicherungen (Vergleich)
  - private Krankenversicherung
  - Energie (Strom & Gas gewerblich)
- **Gesprächsreports** mit Ergebnis, Termin, Absage oder Wiedervorlage
- **Aufnahmelink pro Gespräch**, wenn die Gesprächsaufzeichnung erlaubt wurde
- **E-Mail-Versand** an `Matthias.duic@agentur-duic-sprockhoevel.de` nach jedem Report
- **Outlook-CSV-Export** für vereinbarte Termine
- **Dashboard-Kalender** mit direkter Termineintragung und Detailansicht (inkl. Report & Aufnahme)
- **Stimmtest im Browser** zum Testen von Glorias Gesprächseinstieg
- **Live-KI Zielmodus** für freie, zielorientierte Antworten auch bei Abweichungen vom Skript
- **Webhook-Endpunkt** für echte Telefonie-/Voice-AI-Systeme
- **Feingranulare KI-Call-Felder** für Aufzeichnungserlaubnis (JA/NEIN), Gesundheitsfragen und Terminierungs-Überleitung

## Schnellstart

```bash
npm install
npm run dev
```

Danach im Browser öffnen:

- `http://localhost:3000`

## Wichtige Endpunkte

| Zweck | Route |
|---|---|
| Dashboard-Daten | `/api/reports` |
| CSV-Auftrag importieren | `/api/campaigns/import` |
| Playbooks lesen/speichern | `/api/playbooks` |
| Stimmtest / Prompt-Vorschau | `/api/voice-preview` |
| Gesprächsreport von Telefonie empfangen | `/api/calls/webhook` |
| Telnyx-Testanruf starten | `/api/telnyx/test-call` |
| Telnyx-Anruf starten | `/api/telnyx/call` |
| Telnyx-Event-Webhook | `/api/telnyx/events` |
| Automatische Wiedervorlagen ausführen | `/api/callbacks/run` |
| Outlook-Termine exportieren | `/api/export/outlook` |

## Beispiel: Gesprächsergebnis per Webhook speichern

```bash
curl -X POST http://localhost:3000/api/calls/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "company": "Musterbau GmbH",
    "contactName": "Herr Neumann",
    "topic": "betriebliche Krankenversicherung",
    "summary": "Interesse vorhanden, Termin wurde für nächste Woche gebucht.",
    "outcome": "Termin",
    "appointmentAt": "2026-04-16T09:00:00.000Z",
    "recordingConsent": true,
    "recordingUrl": "https://example.com/audio/call-123.mp3"
  }'
```

## Admin-Zugang schützen

Die Gloria-Oberfläche ist jetzt per **Session-Login** abgesichert. Für den initialen Master-Benutzer werden diese Variablen verwendet:

```env
BASIC_AUTH_USERNAME=MDUIC
BASIC_AUTH_PASSWORD=dein_starkes_passwort
```

Wichtig: Die Admin-Seite und internen APIs sind geschützt. Die Telnyx-Callbacks für Telefonie bleiben bewusst erreichbar.

## SMTP / E-Mail konfigurieren

Kopiere `.env.example` nach `.env` und trage deine echten SMTP-Daten ein.

Dann sendet Gloria nach jedem gespeicherten Gespräch einen Report an:

- `Matthias.duic@agentur-duic-sprockhoevel.de`

## Persistente Datenbank für Reports, Aufnahmen & Skripte

Standardmäßig speichert Gloria Reports lokal als JSON-Dateien. Für produktive, dauerhafte Speicherung kannst du jetzt eine PostgreSQL-Datenbank anbinden:

```env
DATABASE_URL=postgres://user:pass@host:5432/dbname
```

Sobald `DATABASE_URL` gesetzt ist, werden Gesprächsreports, Aufnahmen und die bearbeiteten Skripte in PostgreSQL persistiert (inkl. automatischer Tabellenanlage). Bereits vorhandene Skripte aus dem JSON-Fallback werden beim Laden automatisch in PostgreSQL übernommen. Ohne `DATABASE_URL` nutzt Gloria weiterhin den bestehenden JSON-Fallback.

## OpenAI-Modelle konsistent setzen

Wenn Gloria auch bei Abweichungen vom Skript inhaltlich frei reagieren und trotzdem konsequent auf den Termin hinarbeiten soll, trage zusätzlich einen OpenAI-Key ein:

```env
OPENAI_API_KEY=dein_openai_key
OPENAI_MODEL=gpt-4.1
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
```

Die laufende turn-basierte Gesprächslogik nutzt `OPENAI_MODEL` (empfohlen: `gpt-4.1` für stabile Live-Latenz). `OPENAI_REALTIME_MODEL` ist nur für zukünftige Realtime-Erweiterungen hinterlegt und wird im aktuellen Worker-Flow nicht für die Audioausgabe verwendet.

## ElevenLabs-Stimme aktivieren

Trage zusätzlich in `.env` deine ElevenLabs-Daten ein:

```env
ELEVENLABS_API_KEY=dein_api_key
ELEVENLABS_VOICE_ID=deine_voice_id
ELEVENLABS_MODEL=eleven_v3
ELEVENLABS_STABILITY=0.4
ELEVENLABS_SIMILARITY=0.88
ELEVENLABS_STYLE=0.38
ELEVENLABS_SPEED=0.9
ELEVENLABS_SPEAKER_BOOST=true
```

Danach nutzt der Button **„Stimme testen“** im Dashboard direkt deine echte ElevenLabs-Stimme für Gloria. Ohne diese Werte greift automatisch die Browser-Stimme als Fallback.

## Telnyx direkt anbinden

Wenn du bereits einen **Telnyx-Account** hast, ist Gloria auf direkte Testanrufe vorbereitet.

Trage in `.env.local` ein:

```env
APP_BASE_URL=https://deine-oeffentliche-url.de
TELNYX_API_KEY=dein_telnyx_api_key
TELNYX_CONNECTION_ID=deine_connection_id
TELNYX_PHONE_NUMBER=+49XXXXXXXXXX
TELNYX_MEDIA_STREAM_URL=wss://dein-render-worker.onrender.com/telnyx-stream
```

Danach:

1. lokalen Server starten: `npm run dev`
2. öffentliche URL bereitstellen, z. B. `cloudflared tunnel --url http://localhost:3000` oder `ngrok http 3000`
3. diese URL als `APP_BASE_URL` in `.env.local` setzen
4. im Dashboard unter **„Live-Testanruf“** eine Zielnummer eingeben und den Anruf starten

Telnyx nutzt dann diese Endpunkte:

- `/api/telnyx/call` – startet den Anruf via Telnyx API
- `/api/telnyx/events` – verarbeitet Telnyx-Status- und Stream-Events
- `/api/calls/webhook` – nimmt aggregierte Gesprächsergebnisse entgegen

## Live-Gespräche mit Render-Worker

Gloria läuft im Live-Flow über den Render-Worker stabil im turn-basierten Sprachfluss:

- Telnyx Media Streams für Audio in Echtzeit
- OpenAI Chat Completions für Antwortentscheidungen
- ElevenLabs für Audioausgabe

Der Worker-Endpunkt wird über `TELNYX_MEDIA_STREAM_URL` angebunden.

## So wird daraus echte automatische Telefonie

Für **echte autonome Telefonate über euren Telefonanschluss** brauchst du zusätzlich einen Voice-/Telefonie-Provider, z. B.:

1. **Telnyx** für Rufnummer, Anrufe, Events und Streaming
2. den **Render-Worker** für dauerhafte WebSocket-Verbindungen
3. Übergabe des Gesprächsergebnisses an `/api/calls/webhook`
4. Rückruftermine über geplante Jobs / Scheduler erneut anstoßen

Für automatische Wiedervorlagen ist ein Cron-Job vorkonfiguriert:

- `vercel.json` ruft alle 5 Minuten `/api/callbacks/run` auf.
- Optional absichern mit `CRON_SECRET` in Vercel (Authorization Header `Bearer <CRON_SECRET>`).

Die in `src/lib/gloria.ts` hinterlegte Identität sorgt dafür, dass Gloria:

- sich direkt als **digitale Vertriebsassistentin** erkenntlich macht,
- **im Auftrag von Herrn Duic** spricht,
- **Aufzeichnungserlaubnis** vorab anfragt,
- und intelligent vom Skript abweichen darf, solange das Gespräch zielgerichtet bleibt.

## Rechtlicher Hinweis

> Vor produktivem Einsatz bitte **UWG/DSGVO/TKG** sowie die Zulässigkeit von B2B-Neukundenanrufen und Gesprächsaufzeichnungen rechtlich prüfen. Die Aufzeichnung darf nur mit Zustimmung erfolgen.

## Vercel Umgebungsvariablen (Prod/Preview)

Die folgenden Variablen werden im Code tatsächlich verwendet. Für einen stabilen Betrieb solltest du sie in Vercel getrennt für **Production** und **Preview** setzen.

### 1) Pflicht für Production

| Variable | Zweck |
|---|---|
| `APP_BASE_URL` | Öffentliche App-URL (z. B. `https://gloria-ki-assistent.vercel.app`) |
| `BASIC_AUTH_USERNAME` | Benutzername für Dashboard-Zugriff |
| `BASIC_AUTH_PASSWORD` | Passwort für Dashboard-Zugriff |
| `OPENAI_API_KEY` | Live-Antworten im Telefonie-Gesprächsfluss |
| `OPENAI_MODEL` | Empfohlen: `gpt-4.1` |
| `TELNYX_API_KEY` | Telnyx API-Zugang |
| `TELNYX_CONNECTION_ID` | Telnyx Voice Connection für Outbound Calls |
| `TELNYX_PHONE_NUMBER` | Ausgehende Telnyx-Rufnummer |
| `TELNYX_MEDIA_STREAM_URL` | WSS-URL des Render-Workers (`.../telnyx-stream`) |
| `CALL_STATE_SECRET` | Signierung des Gesprächsstatus-Tokens |

### 2) Pflicht, wenn Feature genutzt wird

| Variable | Nur nötig wenn ... |
|---|---|
| `DATABASE_URL` | Reports/Skripte persistent in PostgreSQL gespeichert werden sollen |
| `SMTP_HOST` | E-Mail-Reports aktiv gesendet werden sollen |
| `SMTP_PORT` | E-Mail-Reports aktiv gesendet werden sollen |
| `SMTP_USER` | E-Mail-Reports aktiv gesendet werden sollen |
| `SMTP_PASS` | E-Mail-Reports aktiv gesendet werden sollen |
| `SMTP_FROM` | E-Mail-Reports aktiv gesendet werden sollen |
| `REPORT_TO_EMAIL` | E-Mail-Reports an abweichende Adresse gehen sollen |
| `ELEVENLABS_API_KEY` | echte ElevenLabs-Stimme genutzt werden soll |
| `ELEVENLABS_VOICE_ID` | echte ElevenLabs-Stimme genutzt werden soll |
| `ELEVENLABS_MODEL` | ElevenLabs-Modell überschrieben werden soll |
| `ELEVENLABS_STABILITY` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SIMILARITY` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_STYLE` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SPEED` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SPEAKER_BOOST` | ElevenLabs-Voice-Tuning genutzt wird |
| `MEDIA_STREAM_WSS_URL` | optionaler Legacy-Fallback für Stream-URL |
| `TELNYX_API_BASE_URL` | nur bei abweichender Telnyx-API-Basis notwendig |
| `LIVE_AI_TIMEOUT_MS` | OpenAI-Timeout vom Standard abweichen soll |

### 3) Empfohlene Belegung für Preview

- Setze mindestens: `APP_BASE_URL`, `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD`.
- Für sichere Tests mit echter Telefonie setze zusätzlich Telnyx + OpenAI Variablen.
- Wenn Preview ohne echte Calls laufen soll, lasse Telnyx/ElevenLabs leer.

### 4) Schnell-Check nach dem Setzen

1. In Vercel Deployments neu ausrollen (`Redeploy`), damit neue Variablen aktiv sind.
2. Health prüfen: `GET /api/health`.
3. Dashboard öffnen und Testlauf machen:
  - Stimmtest
  - Telnyx-Testanruf
  - Report entsteht im Dashboard
4. Outlook-Export prüfen: `GET /api/export/outlook`.

### 5) Beispielwerte (Production)

```env
APP_BASE_URL=https://gloria-ki-assistent.vercel.app
OPENAI_MODEL=gpt-4.1
TELNYX_MEDIA_STREAM_URL=wss://gloria-stream-worker.onrender.com/telnyx-stream
LIVE_AI_TIMEOUT_MS=1000
```
