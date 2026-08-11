# Gloria Stream Worker (Render)

Persistenter WebSocket-Server, der Telnyx Media Streams für Gloria verarbeitet.
Pipeline: **Telnyx (μ-law 8 kHz) → Deepgram ASR → OpenAI GPT-4.1 → ElevenLabs TTS (μ-law 8 kHz) → Telnyx**.

Vercel kann keine langlebigen WebSocket-Server hosten, deshalb läuft dieser
Worker separat auf Render. Vercel liefert weiterhin Dashboard, REST-API,
Reports und das TwiML, das den Anruf via `<Connect><Stream>` an diesen Worker
übergibt.

## Architektur

```
Telnyx  ───►  Vercel /api/telnyx/call  (Call-Control + WebSocket-Stream)
   │
   └── Audio (μ-law 8 kHz, 20 ms Frames)
      └────►  Render-Worker  ws://…/telnyx-stream
                ├─ Deepgram (ASR, mulaw 8000 native)
                ├─ OpenAI Chat Completions (Antwortgenerator)
                └─ ElevenLabs (TTS, output_format=ulaw_8000)
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
   - `DEEPGRAM_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
   - `STREAM_SHARED_SECRET` (z. B. `openssl rand -hex 32`)
   - `APP_INTERNAL_TOKEN` (gleicher Wert wie auf Vercel)
4. **Deploy** klicken. Render baut mit `npm install && npm run build` und startet `npm run start`.
5. Public-URL des Services kopieren (z. B. `https://gloria-stream-worker.onrender.com`).

## Vercel-Seite aktivieren

Auf Vercel folgende Env-Var setzen (Production + Preview):

```
TELNYX_MEDIA_STREAM_URL=wss://gloria-stream-worker.onrender.com/telnyx-stream
```

Optional als Legacy-Fallback (falls bereits genutzt):

```
MEDIA_STREAM_WSS_URL=wss://gloria-stream-worker.onrender.com/telnyx-stream
```

## Status

- [x] WebSocket-Server, Telnyx-Frame-Parser
- [x] Deepgram Streaming-ASR (μ-law 8 kHz nativ, Endpointing 300 ms)
- [x] OpenAI Turn-Handler (JSON-Antwort, max. 25 Wörter)
- [x] ElevenLabs Streaming-TTS direkt in μ-law 8 kHz (kein Resampling nötig)
- [x] Barge-in (Aborts laufende TTS, sobald Deepgram-Partials beim sprechenden
      Zustand eintreffen)
- [x] Opener-Begrüßung beim `start`-Event
- [x] Telnyx Stream-Switch in `src/app/api/telnyx/call/route.ts`
      (`TELNYX_MEDIA_STREAM_URL` gesetzt)

### Offen (nächste Iteration)

- [ ] Persistenz: am Stream-Ende Transcript & Outcome an Vercel posten
      (`POST /api/reports` mit `APP_INTERNAL_TOKEN`).
- [ ] Strukturiertes Outcome-Parsing (Termin / Absage / Wiedervorlage / Kein
      Kontakt) — heute übernimmt das LLM nur `hangup`.
- [ ] Telnyx Event-Signatur prüfen (HMAC mit
      `STREAM_SHARED_SECRET` auf eingehenden Event-Requests).
- [ ] Reconnect-/Retry-Logik bei Deepgram-Drop (~1 % der Fälle).
- [ ] Aufnahme/Recording (Telnyx Recording-Flow parallel zum Stream).
- [ ] Healthcheck mit Provider-Pings (Deepgram/OpenAI/ElevenLabs).

## Operatives

- **Logs**: Render-Dashboard → Service → Logs (JSON-Lines).
- **Restart**: `Manual Deploy → Clear cache and deploy` reicht für Hotfixes.
- **Skalierung**: Starter-Plan (~$7/Monat) hält ~10 parallele Anrufe. Bei mehr
  parallelen Calls auf Standard hochstufen oder Horizontal-Scaling aktivieren.
