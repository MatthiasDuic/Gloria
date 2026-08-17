# Neuaufbau des Gesprächskerns

## Zielarchitektur

Der Gesprächskern wird schrittweise in drei klar getrennte Bereiche aufgeteilt:

1. **Transport:** Telnyx Media Stream, OpenAI-Realtime-Verbindung und Audio-Pufferung.
2. **Conversation Controller:** deterministische Zustände, Pflichtschritte und Tool-Freigaben.
3. **Formulierung:** natürliche deutsche Antworten innerhalb der vom Controller gesetzten Grenzen.

Fachliche Voraussetzungen dürfen nicht allein durch Prompttexte oder das Sprachmodell geprüft werden.

## Erster Migrationsschritt

- `worker/src/pkv-conversation-controller.ts` ist die zentrale Quelle für den PKV-Pflichtstatus.
- Die Hochrechnungsfolge und die Terminfreigabe verwenden dieselbe Zustandsbewertung.
- Ein früheres oder mehrdeutiges "Ja" gilt nicht als Terminfreigabe.
- Der statische PKV-Prompt enthält nur noch einen verbindlichen Standard-Flow.
- `worker/src/contact-routing-controller.ts` trennt Empfang, Warteschleife, Entscheider und Mailbox explizit.
- Erst ein bestätigter Entscheider gelangt in das fachliche PKV-Gespräch.
- `worker/src/appointment-controller.ts` bündelt fachliche Terminfreigabe, Zeitpräferenz und Prüfung der angebotenen Slots.
- `worker/src/conversation-event-controller.ts` unterscheidet Kundenfragen, Einwände, klare Ablehnungen, unklare Äußerungen und normale Antworten.
- Kundenfragen und Einwände werden zuerst beantwortet; anschließend wird am berechneten PKV-Pflichtschritt fortgesetzt.
- Wiederholte unklare ASR-Fragmente erzeugen höchstens eine Rückfrage und verändern keine Fakten oder Freigaben.
- Ereignisklassifikation und `end_call`-Sicherheitsprüfung verwenden dieselbe Quelle für eindeutige Gesprächsenden.
- `worker/src/preparation-controller.ts` steuert Zustimmung, Fragenreihenfolge, bekannte Fakten, Abbruch und Abschluss nach der Terminbestätigung.
- Ein Nein während der Vorbereitung beendet den Fragenkatalog sofort; bereits bekannte Versicherungs- und Beitragsdaten werden nicht erneut erfragt.
- Nach Übermittlung der Bestätigungs-E-Mail wird die E-Mail-Frage nicht wiederholt.
- `worker/src/telnyx-playback.ts` übernimmt Audio-Restpuffer, 160-Byte-Frames, Codec-Padding und das zeitlich korrekte 20-ms-Playback.
- Mehrere Frames aus einem OpenAI-Audio-Delta werden nicht mehr als ungebremster Burst an Telnyx gesendet.
- `worker/src/realtime-response-controller.ts` steuert aktive Antworten, First-in-Queue, Playback-Sperre, Cooldown, Cancel und Shutdown.
- Nicht mehr verwendete Response-, Playback- und Interrupt-Zustände wurden aus dem Realtime-Handler entfernt.
- `worker/src/openai-realtime-session.ts` besitzt WebSocket-Aufbau, Ready-State, JSON-Ereignisverteilung und Eingangsaudio-Pufferung vor Verbindungsöffnung.
- `worker/src/barge-in-controller.ts` plant Unterbrechungen mit den offiziellen Telnyx- und OpenAI-Ereignissen.
- Bei Kundensprache während Glorias Ausgabe wird Telnyx mit `clear` geleert, die OpenAI-Antwort mit `response.cancel` gestoppt und das Assistant-Item mit `conversation.item.truncate` auf die abgespielte Audiozeit gekürzt.
- Alte wartende Antworten und ungespielte fachliche Aussagen werden bei einer Unterbrechung nicht als erledigt übernommen.
- `worker/src/dialog-evaluation.ts` bewertet Produktionscontroller auf Pflichtstufe, Kundenevent, Routing, Terminfreigabe, Fragen pro Turn, Wiederholungen, frühe Terminierung und Latenz.
- `worker/src/dialog-evaluation-scenarios.ts` enthält 38 realistische Positiv- und Negativszenarien für PKV-Fluss, Kundenereignisse, Routing, Termine und Qualitätsregeln.
- `npm run eval:dialogs` liefert einen reproduzierbaren Qualitätsbericht. Aktueller Stand: 38/38 Szenarien und 100/100 Punkte.
- Controller-Szenarien laufen gemeinsam mit den bestehenden Worker-Tests.

## Nächste Schritte

1. Anonymisierte echte Gesprächstranskripte in ein Replay-Format überführen und als zusätzliche Evaluationsfälle aufnehmen.
2. Kontrollierten Testanruf-Rollout mit Barge-in-, Latenz- und Terminmetriken durchführen.
3. Telnyx-Mark-Bestätigungen nutzen, um `audio_end_ms` nicht nur aus gesendeten Frames, sondern aus netzwerkseitig bestätigter Wiedergabe abzuleiten.
4. Alte, nicht mehr aktive Twilio- und ElevenLabs-Pfade nach Produktionsprüfung entfernen.

## Qualitätskriterien

- Kein Termin vor Erfüllung aller fachlichen Voraussetzungen.
- Keine Zustimmung aus Füllwörtern, früheren Antworten oder ASR-Fragmenten ableiten.
- Höchstens eine Frage pro Turn.
- Kundenfragen und Einwände werden vor dem nächsten Pflichtschritt beantwortet.
- Nur tatsächlich bereitgestellte freie Termine dürfen bestätigt werden.
- Dialogszenarien, Typecheck und Build müssen vor jedem Rollout grün sein.