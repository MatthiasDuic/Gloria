# Gloria Stream Worker (Render)

Persistenter WebSocket-Server, der Telnyx Media Streams für Gloria verarbeitet.
Standard-Pipeline: **Telnyx G.711 ↔ OpenAI Realtime Audio**. Das Modell hört,
denkt und spricht in einer persistenten Vollduplex-Session. Der bisherige
ASR/LLM/ElevenLabs-Pfad bleibt als abschaltbarer Rückfallpfad erhalten.

Vercel kann keine langlebigen WebSocket-Server hosten, deshalb läuft dieser
Worker separat auf Render. Vercel liefert weiterhin Dashboard, REST-API,
Reports und die Call-Control-Konfiguration, die den Anruf via WebSocket-Stream an diesen Worker
übergibt.

## Architektur

```
Telnyx  ───►  Vercel /api/telnyx/call  (Call-Control + WebSocket-Stream)
   │
   └── Audio (μ-law 8 kHz, 20 ms Frames)
      └────►  Render-Worker  ws://…/telnyx-stream
                   └─ OpenAI Realtime Audio (semantische VAD, Dialog, Sprache)
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
   - `STREAM_SHARED_SECRET` (z. B. `openssl rand -hex 32`)
   - `APP_INTERNAL_TOKEN` (gleicher Wert wie auf Vercel)
4. **Deploy** klicken. Render baut mit `npm install && npm run build` und startet `npm run start`.
5. Public-URL des Services kopieren (z. B. `https://gloria-stream-worker.onrender.com`).

## Vercel-Seite aktivieren

Auf Vercel folgende Env-Var setzen (Production + Preview):

```
TELNYX_MEDIA_STREAM_URL=wss://gloria-stream-worker.onrender.com/telnyx-stream
```

## Status

- [x] WebSocket-Server, Telnyx-Frame-Parser
- [x] OpenAI Realtime Audio-to-Audio mit direktem G.711-Durchsatz
- [x] Semantische VAD mit niedriger Unterbrechungsneigung und nativem Barge-in
- [x] Topic Policies als flexible Leitplanken statt deterministischem Antwortskript
- [x] Transkript und Reporting aus derselben Realtime-Session
- [x] OpenAI Realtime ASR mit Server-VAD (PCM16 16 kHz)
- [x] OpenAI Turn-Handler (JSON-Antwort, max. 25 Wörter)
- [x] ElevenLabs Streaming-TTS direkt in μ-law 8 kHz (kein Resampling nötig)
- [x] Barge-in (Aborts laufende TTS, sobald OpenAI-Partials beim sprechenden
      Zustand eintreffen)
- [x] Opener-Begrüßung beim `start`-Event
- [x] Telnyx Stream-Switch in `src/app/api/telnyx/call/route.ts`
      (`TELNYX_MEDIA_STREAM_URL` gesetzt)

## Audio-Realtime konfigurieren

```env
OPENAI_AUDIO_REALTIME=true
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_REASONING_EFFORT=low
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_VAD_EAGERNESS=low
```

Audio-Realtime ist der Standard. Nur `OPENAI_AUDIO_REALTIME=false` schaltet
ohne Codeänderung auf die bisherige ASR/Chat/ElevenLabs-Pipeline zurück.
ElevenLabs-Secrets werden nur für diesen Rückfallpfad benötigt.

### Offen (nächste Iteration)

- [ ] Persistenz: am Stream-Ende Transcript & Outcome an Vercel posten
      (`POST /api/reports` mit `APP_INTERNAL_TOKEN`).
- [ ] Strukturiertes Outcome-Parsing (Termin / Absage / Wiedervorlage / Kein
      Kontakt) — heute übernimmt das LLM nur `hangup`.
- [ ] Telnyx Event-Signatur prüfen (HMAC mit
      `STREAM_SHARED_SECRET` auf eingehenden Event-Requests).
- [ ] Reconnect-/Retry-Logik bei OpenAI-Realtime-Drop.
- [ ] Aufnahme/Recording (Telnyx Recording-Flow parallel zum Stream).
- [ ] Healthcheck mit Provider-Pings (OpenAI/ElevenLabs).

## Operatives

- **Logs**: Render-Dashboard → Service → Logs (JSON-Lines).
- **Restart**: `Manual Deploy → Clear cache and deploy` reicht für Hotfixes.
- **Skalierung**: Starter-Plan (~$7/Monat) hält ~10 parallele Anrufe. Bei mehr
  parallelen Calls auf Standard hochstufen oder Horizontal-Scaling aktivieren.
