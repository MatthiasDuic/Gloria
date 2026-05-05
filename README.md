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
| ADS CRM Integration (Lead-Upsert + optional Sofortanruf) | `/api/integrations/ads/leads` |

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

## Beispiel: ADS CRM Lead an Gloria senden

```bash
curl -X POST http://localhost:3000/api/integrations/ads/leads \
  -H "Authorization: Bearer ${ADS_CRM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "mduic",
    "listName": "ADS Import Mai",
    "triggerCalls": false,
    "leads": [
      {
        "externalId": "ADS-4711",
        "company": "Musterbau GmbH",
        "contactName": "Herr Neumann",
        "phone": "+492011234567",
        "email": "neumann@musterbau.de",
        "topic": "private Krankenversicherung",
        "note": "Kommt aus ADS CRM"
      }
    ]
  }'
```

Hinweis:
- Auth läuft über `ADS_CRM_API_KEY`.
- User-Zuordnung läuft über `userId` oder `username` im Payload.
- Optional kann ein Default-User über `ADS_CRM_DEFAULT_USER_ID` oder `ADS_CRM_DEFAULT_USERNAME` gesetzt werden.
- Mit `triggerCalls=true` (oder pro Lead `triggerNow=true`) wird nach dem Upsert direkt ein Twilio-Anruf gestartet.

## ADS CRM Workflow: gespeicherte Suche oder manuelle Firmenauswahl

Die ADS-Integration kann jetzt direkt mit einer gespeicherten Suche oder einer manuell ausgewählten Firmenliste arbeiten.

- `mode: "enqueue"`: Firmen werden als offene Liste in Gloria eingetragen (Standard).
- `mode: "start"`: Firmen werden eingetragen und die Liste sofort aktiviert.
- `mode: "call_now"`: Firmen werden eingetragen und sofort angerufen (wenn Twilio aktiv ist).

### Beispiel 1: Gespeicherte ADS-Suche als offene Liste eintragen

```bash
curl -X POST http://localhost:3000/api/integrations/ads/leads \
  -H "Authorization: Bearer ${ADS_CRM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "mduic",
    "mode": "enqueue",
    "savedSearch": {
      "id": "search-2026-05-05-a",
      "name": "Handwerk NRW > 25 Mitarbeiter",
      "query": "branche=handwerk AND mitarbeiter>25"
    },
    "companies": [
      {
        "externalId": "ADS-1001",
        "firma": "Beispiel Dach GmbH",
        "ansprechpartner": "Herr Keller",
        "telefon": "+492019999111",
        "email": "keller@beispiel-dach.de",
        "branche": "Handwerk",
        "ort": "Essen",
        "mitarbeiterzahl": 48,
        "thema": "betriebliche Krankenversicherung"
      }
    ]
  }'
```

### Beispiel 2: Manuell ausgewählte Firmen sofort anrufen

```bash
curl -X POST http://localhost:3000/api/integrations/ads/leads \
  -H "Authorization: Bearer ${ADS_CRM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "usr_xxxxx",
    "mode": "call_now",
    "companies": [
      {
        "externalId": "ADS-2001",
        "company": "Musterbau GmbH",
        "contactName": "Frau Neumann",
        "phone": "+492011234567",
        "topic": "private Krankenversicherung",
        "note": "Vom Vertrieb priorisiert"
      }
    ]
  }'
```

Die ADS-Kontextdaten (z. B. Branche, Ort, Website, Suchname) werden beim Lead gespeichert, damit Gloria vor dem Call die relevanten Informationen im Datensatz hat.

## Was in A-D-S CRM einzurichten ist (Schritt fuer Schritt)

Damit Firmen aus A-D-S automatisch bei Gloria landen, brauchst du in A-D-S einen HTTP-Export bzw. Webhook auf den Endpoint:

- `POST https://gloria-ki-assistant.vercel.app/api/integrations/ads/leads`

### 1) Authentifizierung in A-D-S setzen

- Header setzen: `Authorization: Bearer <ADS_CRM_API_KEY>`
- Alternativ: `x-ads-api-key: <ADS_CRM_API_KEY>`
- Den API-Key in Vercel als `ADS_CRM_API_KEY` hinterlegen.

### 2) Ziel-User fuer die Leads festlegen

Eine der Varianten verwenden:

- im Payload `userId` senden, oder
- im Payload `username` senden, oder
- in Vercel Default setzen: `ADS_CRM_DEFAULT_USER_ID` oder `ADS_CRM_DEFAULT_USERNAME`

### 3) Feldmapping von A-D-S auf Gloria

Du kannst deutsche oder englische Feldnamen senden.

| A-D-S Feld | Gloria Feld | Pflicht | Beispiel |
|---|---|---|---|
| `firma` oder `company` | `company` | ja | `Musterbau GmbH` |
| `ansprechpartner` oder `contactName` | `contactName` | nein | `Frau Neumann` |
| `telefon` oder `phone` | `phone` | ja* | `+492011234567` |
| `durchwahl` oder `directDial` | `directDial` | nein | `+492011234568` |
| `email` | `email` | nein | `kontakt@firma.de` |
| `thema` oder `topic` | `topic` | nein | `private Krankenversicherung` |
| `notiz` oder `note` | `note` | nein | `Warmkontakt von Messe` |
| `externalId` | `externalId` | nein | `ADS-2001` |
| `branche` | in CRM-Kontext | nein | `Handwerk` |
| `ort` | in CRM-Kontext | nein | `Essen` |
| `website` | in CRM-Kontext | nein | `https://firma.de` |
| `mitarbeiterzahl` | in CRM-Kontext | nein | `48` |

`*` Es muss mindestens `phone` oder `directDial` vorhanden sein.

### 4) Modus pro Uebergabe bestimmen

- `mode: "enqueue"` -> Firmen nur als offene Liste eintragen
- `mode: "start"` -> Liste eintragen und direkt aktivieren
- `mode: "call_now"` -> sofort anrufen (Twilio muss konfiguriert sein)

### 5) Zwei typische A-D-S Use Cases

- Gespeicherte Suche uebertragen:
  - `savedSearch.id`, `savedSearch.name`, `savedSearch.query` mitschicken
  - Ergebnisfirmen als `companies` senden
- Manuelle Auswahl uebertragen:
  - nur die selektierten Firmen als `companies` senden

### 6) Rueckmeldung aus Gloria auswerten

Die API liefert dir:

- `created`: neu angelegte Firmen
- `updated`: aktualisierte Firmen
- `listId`, `listName`: Ziel-Liste in Gloria
- `callResults`: Ergebnis je Sofortanruf (bei `call_now`)

### 7) Go-Live Check

1. In A-D-S einen Test mit 1-2 Firmen schicken.
2. In Gloria pruefen, ob die Liste unter Kampagnen erscheint.
3. Bei `mode: start` pruefen, ob die Liste aktiv ist.
4. Bei `mode: call_now` pruefen, ob `callSid` in `callResults` zurueckkommt.
5. Nach dem Gespraech im Gloria-Dashboard Report pruefen.

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
OPENAI_MODEL=gpt-5
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
```

Die laufende turn-basierte Gesprächslogik nutzt `OPENAI_MODEL`. Wenn dein OpenAI-Account es freigeschaltet hat, kannst du hier direkt auf `gpt-5.4` wechseln. `OPENAI_REALTIME_MODEL` ist für zukünftige Realtime-Erweiterungen zentral hinterlegt und bewusst auf `gpt-4o-realtime-preview` fixiert.

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

Gloria läuft auf Vercel stabil im turn-basierten Sprachfluss:

- Twilio Gather für Spracheingaben
- OpenAI Chat Completions für Antwortentscheidungen
- ElevenLabs für Audioausgabe

Es wird kein separater Media-Stream-Endpunkt benötigt.

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
| `OPENAI_MODEL` | Empfohlen: `gpt-5` (optional `gpt-5.4`, falls verfügbar) |
| `TWILIO_ACCOUNT_SID` | Twilio API-Zugang |
| `TWILIO_AUTH_TOKEN` | Twilio API-Zugang |
| `TWILIO_PHONE_NUMBER` | Ausgehende Twilio-Rufnummer |
| `CALL_STATE_SECRET` | Signierung des Gesprächsstatus-Tokens |
| `ADS_CRM_API_KEY` | API-Key für ADS CRM Push auf `/api/integrations/ads/leads` |

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
| `ADS_CRM_DEFAULT_USER_ID` | ADS-Imports ohne `userId` einem festen User zugeordnet werden sollen |
| `ADS_CRM_DEFAULT_USERNAME` | ADS-Imports ohne `username` einem festen User zugeordnet werden sollen |

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
