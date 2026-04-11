# Gloria – KI-Assistentin für B2B-Neukundenakquise

Dieses Projekt erstellt eine **einsatzbereite Admin-Oberfläche** für `Gloria`, die digitale Vertriebsassistentin im Auftrag von **Herrn Matthias Duic**.

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
- **Stimmtest im Browser** zum Testen von Glorias Gesprächseinstieg
- **Live-KI Zielmodus** für freie, zielorientierte Antworten auch bei Abweichungen vom Skript
- **Webhook-Endpunkt** für echte Telefonie-/Voice-AI-Systeme

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
| Live-Agent-Konfiguration | `/api/live-agent` |
| Freie KI-Antwort simulieren | `/api/live-agent/respond` |
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

Die Gloria-Oberfläche ist jetzt per **HTTP Basic Auth** absicherbar. Lege dafür in deiner Umgebung diese Variablen an:

```env
BASIC_AUTH_USERNAME=MDUIC
BASIC_AUTH_PASSWORD=dein_starkes_passwort
```

Wichtig: Die Admin-Seite und internen APIs sind dann geschützt. Die Twilio-Webhooks für Telefonie bleiben bewusst erreichbar.

## SMTP / E-Mail konfigurieren

Kopiere `.env.example` nach `.env` und trage deine echten SMTP-Daten ein.

Dann sendet Gloria nach jedem gespeicherten Gespräch einen Report an:

- `Matthias.duic@agentur-duic-sprockhoevel.de`

## Live-KI für freie Gesprächsführung aktivieren

Wenn Gloria auch bei Abweichungen vom Skript inhaltlich frei reagieren und trotzdem konsequent auf den Termin hinarbeiten soll, trage zusätzlich einen OpenAI-Key ein:

```env
LIVE_AI_PROVIDER=openai
OPENAI_API_KEY=dein_openai_key
OPENAI_MODEL=gpt-4.1-mini
```

Dann kann der Endpoint `/api/live-agent/respond` spontane Aussagen des Interessenten in eine passende nächste Gloria-Antwort übersetzen. Ohne Key greift automatisch eine zielorientierte Fallback-Logik.

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

Die in `src/lib/gloria.ts` hinterlegte Identität sorgt dafür, dass Gloria:

- sich direkt als **digitale Vertriebsassistentin** erkenntlich macht,
- **im Auftrag von Herrn Duic** spricht,
- **Aufzeichnungserlaubnis** vorab anfragt,
- und intelligent vom Skript abweichen darf, solange das Gespräch zielgerichtet bleibt.

## Rechtlicher Hinweis

> Vor produktivem Einsatz bitte **UWG/DSGVO/TKG** sowie die Zulässigkeit von B2B-Neukundenanrufen und Gesprächsaufzeichnungen rechtlich prüfen. Die Aufzeichnung darf nur mit Zustimmung erfolgen.
