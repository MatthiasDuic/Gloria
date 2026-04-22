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
| Skript speichern | `/api/scripts` |
| Stimmtest / Prompt-Vorschau | `/api/scripts/test-voice` |
| Gesprächsreport von Telefonie empfangen | `/api/calls/webhook` |
| Twilio-Testanruf starten | `/api/twilio/test-call` |
| Twilio-Sprachdialog (Webhook) | `/api/twilio/voice` |
| Twilio-Status-Webhook | `/api/twilio/status` |
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

Wichtig: Die Admin-Seite und internen APIs sind geschützt. Die Twilio-Webhooks für Telefonie bleiben bewusst erreichbar.

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
OPENAI_MODEL=gpt-4.1-mini
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
```

Die laufende turn-basierte Gesprächslogik nutzt `OPENAI_MODEL`. `OPENAI_REALTIME_MODEL` wird für vorbereitete Realtime-Sessions und die Telephony-Runtime-Konfiguration genutzt.

## ElevenLabs-Stimme aktivieren

Trage zusätzlich in `.env` deine ElevenLabs-Daten ein:

```env
ELEVENLABS_API_KEY=dein_api_key
ELEVENLABS_VOICE_ID=deine_voice_id
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_STABILITY=0.45
ELEVENLABS_SIMILARITY_BOOST=0.8
```

Danach nutzt der Button **„Stimme testen“** im Dashboard direkt deine echte ElevenLabs-Stimme für Gloria. Ohne diese Werte greift automatisch die Browser-Stimme als Fallback.

## Twilio direkt anbinden

Wenn du bereits einen **Twilio-Account** hast, ist Gloria jetzt auf einen direkten Testanruf vorbereitet.

Trage in `.env.local` ein:

```env
APP_BASE_URL=https://deine-oeffentliche-url.de
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=dein_auth_token
TWILIO_PHONE_NUMBER=+49XXXXXXXXXX
```

Danach:

1. lokalen Server starten: `npm run dev`
2. öffentliche URL bereitstellen, z. B. `cloudflared tunnel --url http://localhost:3000` oder `ngrok http 3000`
3. diese URL als `APP_BASE_URL` in `.env.local` setzen
4. im Dashboard unter **„Twilio Live-Testanruf“** eine Zielnummer eingeben und den Anruf starten

Twilio ruft dann diese Endpunkte auf:

- `/api/twilio/voice` – Gloria eröffnet das Gespräch
- `/api/twilio/audio` – liefert bei aktiver ElevenLabs-Konfiguration die echte Gloria-Stimme als Audio
- `/api/twilio/voice/process` – verarbeitet jetzt auch mehrstufige, freie Live-Gespräche auf Vercel
- `/api/twilio/status` – nimmt Statusupdates von Twilio entgegen

## Live-Gespräche auf Vercel

Gloria kann jetzt in einem **Vercel-tauglichen Live-Modus** mehrstufig auf freie Antworten reagieren. Dafür setze optional:

```env
TWILIO_CONVERSATION_MODE=live
```

Wenn du später mit einem echten WebSocket-Stream arbeiten willst, kannst du vorbereitend zusätzlich setzen:

```env
TWILIO_CONVERSATION_MODE=media-stream
TWILIO_MEDIA_STREAM_URL=wss://dein-stream-endpunkt
```

Ohne `TWILIO_MEDIA_STREAM_URL` bleibt Gloria automatisch im funktionierenden Live-Gesprächsmodus auf Basis von Twilio Speech Gather.

## So wird daraus echte automatische Telefonie

Für **echte autonome Telefonate über euren Telefonanschluss** brauchst du zusätzlich einen Voice-/Telefonie-Provider, z. B.:

1. **Twilio** für Rufnummer, Anrufe und Webhooks
2. optional **Vapi** oder **Retell AI** für noch freiere Live-KI-Konversation
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
| `OPENAI_API_KEY` | Live-Antworten im Twilio-Gesprächsfluss |
| `OPENAI_MODEL` | Empfohlen: `gpt-4o` |
| `TWILIO_ACCOUNT_SID` | Twilio API-Zugang |
| `TWILIO_AUTH_TOKEN` | Twilio API-Zugang |
| `TWILIO_PHONE_NUMBER` | Ausgehende Twilio-Rufnummer |
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
| `ELEVENLABS_MODEL_ID` | ElevenLabs-Modell überschrieben werden soll |
| `ELEVENLABS_STABILITY` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SIMILARITY_BOOST` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_STYLE` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SPEED` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_USE_SPEAKER_BOOST` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_LATENCY_MODE` | ElevenLabs Streaming-Latenz explizit gesteuert wird |
| `TWILIO_CONVERSATION_MODE` | Modus explizit gesetzt werden soll (`live`/`media-stream`) |
| `TWILIO_MEDIA_STREAM_URL` | `TWILIO_CONVERSATION_MODE=media-stream` genutzt wird |
| `LIVE_AI_TIMEOUT_MS` | OpenAI-Timeout vom Standard abweichen soll |

### 3) Empfohlene Belegung für Preview

- Setze mindestens: `APP_BASE_URL`, `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD`.
- Für sichere Tests mit echter Telefonie setze zusätzlich Twilio + OpenAI Variablen.
- Wenn Preview ohne echte Calls laufen soll, lasse Twilio/ElevenLabs leer.

### 4) Schnell-Check nach dem Setzen

1. In Vercel Deployments neu ausrollen (`Redeploy`), damit neue Variablen aktiv sind.
2. Health prüfen: `GET /api/health`.
3. Dashboard öffnen und Testlauf machen:
  - Stimmtest
  - Twilio-Testanruf
  - Report entsteht im Dashboard
4. Outlook-Export prüfen: `GET /api/export/outlook`.

### 5) Beispielwerte (Production)

```env
APP_BASE_URL=https://gloria-ki-assistent.vercel.app
OPENAI_MODEL=gpt-4o
TWILIO_CONVERSATION_MODE=live
LIVE_AI_TIMEOUT_MS=1000
```
