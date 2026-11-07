# Gloria KI-Assistentin – Betrieb und Deployment

## Architektur

```
Kampagne / CRM / manueller Anruf
        │
        ▼
Vercel (Next.js, gloria.agentur-duic-sprockhoevel.de)
  ├─ queueOutboundCall → processOutboundCallQueue → createTelnyxCall
  │     └─ Vorab-Check: Worker /readyz (Guthaben, Zugang) – bei Ausfall kein Anruf
  ├─ Telnyx Call Control + Webhooks (/api/telnyx/events)
  └─ PostgreSQL (Leads, Kampagnen, Berichte, Warteschlange)
        │
        ▼  Telnyx Media Stream (G.711 PCMA, 8 kHz)
Render-Worker (gloria-tebr.onrender.com, /telnyx-stream)
  ├─ OpenAI Realtime gpt-realtime-2.1 (Hören, Transkript, Dialog, Tools)
  ├─ ElevenLabs eleven_v4_turbo (Stimme), Ersatzstimme OpenAI TTS
  └─ Bericht an die App (/api/reports, mit Wiederholungen)
```

Alle Anrufe – Kampagne, Wiedervorlage, CRM und manuell – laufen über dieselbe
Warteschlange. Es gibt keinen zweiten Anrufpfad. Maximal drei Gespräche laufen
gleichzeitig; weitere Aufträge warten persistent in PostgreSQL.

## Deploy

- **App (Vercel)**: Push auf `main` deployt automatisch.
- **Worker (Render)**: Push auf `main` deployt automatisch (`render.yaml`,
  `autoDeploy: true`). Die laufende Revision steht in `GET /readyz` unter `revision`.

Prüfung nach dem Deploy:

```bash
curl -s https://gloria-tebr.onrender.com/readyz
```

`ok: true`, `blocking: false` und eine leere `issues`-Liste bedeuten: Gloria ist
startklar.

## Umgebungsvariablen

- App: siehe `.env.example`.
- Worker: siehe `worker/.env.example` und `worker/README.md`.

Pflicht in der App: `DATABASE_URL`, `APP_BASE_URL`, `APP_INTERNAL_TOKEN`,
`CRON_SECRET`, `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_PHONE_NUMBER`,
`TELNYX_PUBLIC_KEY`, `WORKER_HEALTHCHECK_URL`, `OPENAI_API_KEY`.

## Cron-Jobs (vercel.json)

| Pfad | Zweck |
| --- | --- |
| `/api/calls/queue/process` | Anrufwarteschlange abarbeiten (jede Minute) |
| `/api/callbacks/run` | Fällige Wiedervorlagen und Gloria-Aufgaben anrufen |
| `/api/campaigns/run-active` | Aktive Kampagnen in den Kampagnenzeiten befüllen |
| `/api/jobs/process` | Hintergrundjobs |
| `/api/reports/cleanup` | Nächtliche Bereinigung |
| `/api/campaign-knowledge/refresh` | Wissensquellen der Kampagnen aktualisieren |
| `/api/learning/optimize/cron` | Wöchentliche Leitfaden-Optimierung |
| `/api/controlling/daily-sync` | Controlling-Abgleich |

## Ausfälle von OpenAI oder ElevenLabs

Das automatische Aufladen bei OpenAI ist nicht aktiv. Deshalb gilt:

1. Der Worker prüft das OpenAI-Guthaben regelmäßig. Ist es aufgebraucht oder der
   Zugang ungültig, meldet `/readyz` `blocking: true`.
2. Vor jedem Anruf fragt die App `/readyz` ab. Bei `blocking: true` wird nicht
   gewählt, der Lead bleibt offen, die betroffene Kampagne wird pausiert und es
   geht eine Betriebsmail „Gloria pausiert: …“ an `REPORT_TO_EMAIL`
   (höchstens alle 30 Minuten).
3. Nach dem Aufladen ist Gloria nach etwa einer Minute wieder startklar. Die
   Kampagne muss danach im CRM wieder gestartet werden.
4. Fällt OpenAI mitten im Gespräch aus, verabschiedet sich Gloria höflich und legt
   auf (Ergebnis `Fehler`). Liefert ElevenLabs kurz kein Audio, spricht Gloria die
   Antwort mit der Ersatzstimme.

## Ergebnisse im Bericht

Neben dem Gesprächsausgang (Termin, Wiedervorlage, Absage, Nicht erreicht)
erhält jeder Anruf ein Ein-Wort-Ergebnis, z. B. `Aufgelegt`, `Anrufbeantworter`,
`Telefonmenü`, `Warteschleife`, `KI-Assistent`, `Weitergeleitet`,
`Rückrufnummer`, `Ausgeschieden`, `Gesperrt`, `Zeitlimit`, `Fehler` sowie aus
Telnyx `Besetzt`, `Unbeantwortet`, `Ungültig`, `Abgewiesen`. Ein Löschwunsch
(`Gesperrt`) sperrt die Nummer dauerhaft für weitere Anrufe.

## Fehlerbilder

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| Anruf startet nicht, Meldung „Gloria ist nicht startklar“ | Guthaben oder Zugang bei OpenAI/ElevenLabs | Aufladen bzw. Schlüssel prüfen, `/readyz` kontrollieren, Kampagne neu starten |
| Kampagne steht auf pausiert | Anbieter-Ausfall (siehe Betriebsmail) | wie oben |
| Ergebnis `Fehler` | Abbruch durch einen Anbieter während des Gesprächs | Worker-Logs auf Render prüfen (`realtime.openai_outage`, `realtime.elevenlabs_outage`) |
| Gloria antwortet langsam | Latenz OpenAI/ElevenLabs | Logs `realtime.turn_latency`, `realtime.response_usage` prüfen |
