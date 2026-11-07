# Gloria Stream Worker (Render)

Persistenter WebSocket-Server, der Telnyx Media Streams für Gloria verarbeitet.
Standard-Pipeline: **Telnyx G.711 ↔ OpenAI Realtime + ElevenLabs**. OpenAI hört,
transkribiert und steuert den Dialog; ElevenLabs erzeugt die Stimme direkt als
G.711-Telefoncodec.

Vercel kann keine langlebigen WebSocket-Server hosten, deshalb läuft dieser
Worker separat auf Render. Vercel liefert weiterhin Dashboard, REST-API,
Reports und die Call-Control-Konfiguration, die den Anruf via WebSocket-Stream an diesen Worker
übergibt.

Bei Empfang und Weiterleitung bestätigt Gloria ein angebotenes Verbinden einmal
kurz. Während des tatsächlichen Durchstellens und in Warteschleifen spricht sie
nicht; nach einer menschlichen Ansprache stellt sie sich bei der neuen Person
vor und klärt bei Bedarf deren Identität. Fragen nach dem Anrufgrund beantwortet
sie kurz anhand des Kampagnenauftrags, ohne erneut um die Verbindung zu bitten.
Die bestehende Wartegrenze ohne menschlichen Kontakt beträgt drei Minuten.
Fragt der Empfang bei abwesender Zielperson nach einer Rückrufnummer, nennt
Gloria die im Benutzerkonto hinterlegte reale Rufnummer einzeln und wartet auf
eine Bestätigung. Sie wiederholt die Nummer auf Wunsch und meldet ehrlich, wenn
keine gültige reale Rufnummer hinterlegt ist.

## Architektur

```
Telnyx  ───►  Vercel /api/telnyx/call  (Call-Control + WebSocket-Stream)
   │
   └── Audio (G.711 A-law/PCMA 8 kHz, 20 ms Frames)
      └────►  Render-Worker  ws://…/telnyx-stream
                   └─ OpenAI Realtime Text (semantische VAD, Dialog, Tools)
                         └─ ElevenLabs Audio-Stream (A-law/μ-law 8 kHz)
                         ├─ Topic Policies als flexible fachliche Leitplanken
                         └─ Tools: Termin bestätigen, Übergabe, Gespräch beenden
```

## Lokale Entwicklung

```bash
cd worker
cp .env.example .env  # Keys eintragen
npm install
npm run dev           # tsx watch — Reload bei Änderungen
```

Der Worker hört auf `http://localhost:8080`. Health-Check: `GET /health`.
Telnyx-Streams: `ws://localhost:8080/telnyx-stream`.

Lokales Testing mit echten Anrufen geht via [ngrok](https://ngrok.com/):

```bash
ngrok http 8080
# Setze TELNYX_MEDIA_STREAM_URL=wss://<sub>.ngrok-free.app/telnyx-stream auf Vercel
```

## Deploy auf Render (1× Setup)

1. **Repository verbinden**: Render-Dashboard → New → Blueprint → Repo `MatthiasDuic/Gloria` auswählen.
2. Render erkennt `render.yaml` im Root und legt den Service `gloria-stream-worker` automatisch an.
3. **Secrets eintragen** (Render → Service → Environment):
   - `OPENAI_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `APP_INTERNAL_TOKEN` (gleicher Wert wie auf Vercel)
   - `TELNYX_API_KEY` (nur für den Telnyx-Check in `/readyz`)
4. **Deploy** klicken. Render baut mit `npm install && npm run build` und startet `node dist/index.js`.
5. Public-URL des Services: `https://gloria-tebr.onrender.com`.

## Vercel-Seite

Auf Vercel (Production + Preview):

```
WORKER_HEALTHCHECK_URL=https://gloria-tebr.onrender.com/health
TELNYX_MEDIA_STREAM_URL=wss://gloria-tebr.onrender.com/telnyx-stream
```

Der Stream-Pfad wird immer auf `/telnyx-stream` gesetzt; das ist der einzige
WebSocket-Endpunkt des Workers.

## Endpunkte

- `GET /health` – Liveness, antwortet sofort.
- `GET /readyz` – Readiness inkl. Anbieterstatus. Antwort enthält `dependencies`,
  `issues` (deutsche Klartextmeldungen), `reportStorageReady` und `blocking`.
  Nur `ok: true` und `blocking: false` erlauben neue Anrufe. Auch ein Timeout,
  eine ungültige Antwort oder ein nicht beschreibbarer Berichtsspeicher
  verhindern das Wählen; die betroffene Kampagne wird pausiert.
- `POST /prepare-call` – wärmt den Gesprächskontext vor dem Wählen vor.
- `WS /telnyx-stream` – Telnyx Media Stream (G.711, 8 kHz).

## Ausfallschutz

- **OpenAI-Guthaben**: Der Worker prüft das Guthaben alle 5 Minuten mit einem
  minimalen Request (`OPENAI_CREDIT_PROBE_MS`, `OPENAI_CREDIT_PROBE_MODEL`), bei
  bestehendem Ausfall jede Minute. Nach dem Aufladen ist Gloria nach etwa einer
  Minute wieder startklar.
- **Ausfall während eines Gesprächs**: Meldet OpenAI mitten im Gespräch Quota-,
  Auth- oder Serverfehler, verabschiedet sich Gloria mit einem festen Satz
  („Entschuldigung, wir haben gerade ein technisches Problem …“) und legt auf.
  Ergebnis im Bericht: `Fehler`, kein stilles Hängenbleiben.
- **Ersatzstimme**: Liefert ElevenLabs für eine Antwort kein Audio, spricht Gloria
  diese Antwort mit der OpenAI-Sprachausgabe (`FALLBACK_TTS_ENABLED`,
  `FALLBACK_TTS_MODEL`, `FALLBACK_TTS_VOICE`). Das ist nur für kurze Aussetzer
  gedacht; ein erschöpftes ElevenLabs-Kontingent stoppt neue Anrufe.
- **Report-Outbox**: Der Endbericht wird vor dem ersten Zustellversuch atomar
  gespeichert. Render verwendet eine persistente 1-GB-Disk unter `/var/data`
  (`render.yaml`); die Berichte liegen in `/var/data/gloria-outbox`.
  `GLORIA_OUTBOX_DIR` überschreibt diesen Pfad für andere Installationen.
  Beim Start und alle zwei Minuten werden offene Berichte erneut gesendet.
  Gelöscht wird erst nach erfolgreicher Zustellung, nicht nach 24 Stunden.
  Beschädigte Einträge bleiben erhalten und erzeugen `outbox.delivery_failed`.
  Zugriff nur für den Worker; die Dateien können Transkripte und Gesundheitsangaben enthalten.
- **Disk-Betrieb**: Render berechnet aktuell 0,25 USD/Monat für 1 GB.
  Die Disk bleibt bei Neustarts und Deployments erhalten. Sie bindet den Worker
  an eine Instanz und deaktiviert Zero-Downtime-Deployments. Während eines
  Deployments blockiert die Vorabprüfung neue Anrufe.

## Anrufbeantworter und Ansagen

Telnyx-AMD ist bewusst nicht aktiv: Es kostet pro Anruf, verzögert die
Begrüßung um mehrere Sekunden und würde mit der eigenen Erkennung konkurrieren.
Gloria erkennt Mailboxen, Bandansagen („außerhalb unserer Geschäftszeiten“),
Telefonmenüs und Warteschleifen am Transkript (`src/call-classification.ts`)
und vergibt eindeutige Ergebnisse wie `Anrufbeantworter` oder `Telefonmenü`.

## Wichtige Umgebungsvariablen

```env
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_REASONING_EFFORT=low
OPENAI_REALTIME_MAX_OUTPUT_TOKENS=220
OPENAI_REALTIME_SILENCE_MS=650
OPENAI_REALTIME_PREFIX_PADDING_MS=300
OPENAI_RESPONSE_COOLDOWN_MS=40
ELEVENLABS_MODEL=eleven_v4_turbo
ELEVENLABS_FALLBACK_MODEL=eleven_multilingual_v2
ELEVENLABS_STREAMING_LATENCY=2
FALLBACK_TTS_ENABLED=true
```

## Qualitätssicherung vor Deploy

1. `npm test` im Repo-Root (enthält die Worker-Tests).
2. Typecheck: `tsc -p worker/tsconfig.json --noEmit` und `tsc --noEmit -p .`.
3. Mindestens ein Testanruf mit Unterbrechung (Barge-in) und einer mit Empfang/Weiterleitung.
4. Latenz in den Logs prüfen: `realtime.turn_latency`, `realtime.response_usage`
   (zeigt auch `cachedInputTokens` für den Prompt-Cache).

## Operatives

- **Logs**: Render-Dashboard → Service → Logs (JSON-Lines).
- **Restart**: `Manual Deploy → Clear cache and deploy` reicht für Hotfixes.
- **Parallelität**: Gloria startet maximal drei ausgehende Telefonate gleichzeitig.
  Weitere Aufträge bleiben persistent in PostgreSQL in der Warteschlange und
  werden nach Gesprächsende fair nach Benutzer rotiert. Die Auslastung und
  eigene wartende Aufträge erscheinen im CRM. Dafür müssen `DATABASE_URL` und
  `CRON_SECRET` in Vercel konfiguriert sein; der Queue-Cron dient als Fallback,
  falls ein Telnyx-Endereignis den nächsten Auftrag nicht unmittelbar anstößt.
- **Skalierung**: Das Limit von drei schützt den gemeinsamen Worker und die
  KI-Dienste. Eine Erhöhung sollte erst nach einem Lasttest und Anpassung des
  Limits erfolgen; der Render-Plan allein garantiert keine Gesprächsqualität.
