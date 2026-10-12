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
- Termin und Durchführungsart können in derselben Kundenantwort gewählt werden; es folgt keine doppelte Rückfrage oder Bestätigung.
- Die zwei Kalenderoptionen werden natürlich angeboten, ohne einschränkende Formulierungen wie „ausschließlich diese Termine“.
- Nach den freiwilligen Basisfragen wird immer die E-Mail-Adresse für die Terminbestätigung erfragt; danach folgt die feste Schlussformel ohne Bestätigung zum Auflegen.
- Nach erfasster E-Mail-Adresse kündigt Gloria die Terminbestätigung an und weist darauf hin, dass vorab per Antwort auf die E-Mail Fragen gestellt werden können. Die kurze Standardverabschiedung bleibt Ablehnungen und Gesprächen ohne Termin vorbehalten.
- Der PKV-Anlass und die Frage nach einem kurzen Moment werden im Entscheider-Einstieg genau einmal genannt; nach Zustimmung beginnt direkt die Beitragsentwicklung ohne Wiederholung.
- Das vollständige Gespräch wird neben den Transkriptereignissen als Report-Fallback gesichert, damit Detailansicht und PDF auch bei einem Ausfall der separaten Transkripttabelle vollständig bleiben.
- Der konkret bestätigte Kalender-Slot und die Terminart werden strukturiert im Gesprächsreport gespeichert; die ausgeschriebene Sprachform wird ausschließlich für ElevenLabs verwendet.
- Der Kundenterminbogen übernimmt die tatsächlich angerufene Zielnummer. Bei der Terminart stehen nur „Beim Kunden vor Ort“ und „Microsoft Teams“ zur Auswahl.
- Der Kundenterminbogen übernimmt Versicherungsstatus, Versicherer, Beitrag, Geburtsdatum, Größe, Gewicht, Behandlungen, Diagnosen und E-Mail aus den tatsächlich gestellten Vorbereitungsfragen.
- Eine bloße Bestätigung, sich an den Einstiegsbeitrag zu erinnern, zählt nicht als Beitragsangabe; Gloria fragt den damaligen Betrag konkret nach und wechselt erst nach Betrag oder ausdrücklichem Nichtwissen zum heutigen Beitrag.
- Eine persönliche Zehn-Jahres-Hochrechnung wird ausschließlich aus einer Beitragsangabe nach der expliziten Frage zum heutigen Beitrag erzeugt; der Einstiegsbeitrag wird technisch nie als Hochrechnungsbasis zurückgegeben.
- Zusammengesetzte deutsche Beitragsangaben wie „neunhundert Euro“ werden vollständig als 900 ausgewertet und nicht anhand des Teilworts „hundert“ verkürzt.
- `worker/src/telnyx-playback.ts` übernimmt Audio-Restpuffer, 160-Byte-Frames, Codec-Padding und das zeitlich korrekte 20-ms-Playback.
- Mehrere Frames aus einem OpenAI-Audio-Delta werden nicht mehr als ungebremster Burst an Telnyx gesendet.
- `worker/src/realtime-response-controller.ts` steuert aktive Antworten, First-in-Queue, Playback-Sperre, Cooldown, Cancel und Shutdown.
- Nicht mehr verwendete Response-, Playback- und Interrupt-Zustände wurden aus dem Realtime-Handler entfernt.
- `worker/src/openai-realtime-session.ts` besitzt WebSocket-Aufbau, Ready-State, JSON-Ereignisverteilung und Eingangsaudio-Pufferung vor Verbindungsöffnung.
- `worker/src/barge-in-controller.ts` plant Unterbrechungen mit den offiziellen Telnyx- und OpenAI-Ereignissen.
- Bei Kundensprache während Glorias Ausgabe wird Telnyx mit `clear` geleert und eine noch laufende OpenAI-Textantwort mit `response.cancel` gestoppt. Ein OpenAI-Audio-Truncate wird nicht mehr gesendet, weil die hörbare Ausgabe ausschließlich von ElevenLabs stammt.
- Alte wartende Antworten und ungespielte fachliche Aussagen werden bei einer Unterbrechung nicht als erledigt übernommen.
- Deterministische PKV-, Termin- und Vorbereitungsfragen laufen direkt vom Conversation Controller zu ElevenLabs. Sie warten nicht mehr auf eine inhaltlich überflüssige OpenAI-Textgenerierung.
- Direkt gesprochene Controller-Texte werden zusätzlich als Assistant-Nachrichten in die OpenAI-Konversation eingetragen, damit freie Antworten und Einwandbehandlung den vollständigen Gesprächskontext behalten.
- OpenAI Realtime ist konsequent text-only; nicht erreichbare OpenAI-Audio- und Audio-Transcript-Ereignispfade wurden entfernt.
- Die vollständige Kalenderliste bleibt Maschinenzustand des Termincontrollers und wird nicht mehr in den statischen Modellprompt injiziert. Nur die zwei tatsächlich angebotenen Slots werden gesprochen.
- Der Standard-ASR-Kontext wurde auf Zahlen und Eigennamen verkürzt, um synthetische Prompt-Transkripte zu vermeiden; der bestehende Leakage-Filter bleibt als Sicherheitsnetz aktiv.
- Das serverseitige VAD wartet standardmäßig 500 statt 650 Millisekunden Stille. Der Wert bleibt über `OPENAI_REALTIME_SILENCE_MS` konfigurierbar.
- Gepuffertes Eingangsaudio wird nach einem OpenAI-Reconnect erst geleert, nachdem die Sessioninitialisierung abgeschlossen ist.
- `/health` und `/healthz` prüfen nur den lokalen Worker-Prozess. Der separate Endpoint `/readyz` prüft OpenAI, Telnyx und ElevenLabs und cached das Ergebnis standardmäßig 30 Sekunden.
- Nicht aktive Topic-Architekturdateien, der ungenutzte Busy-Slot-Prompt und veraltete PKV-/Dialogzustände wurden entfernt.
- `worker/src/dialog-evaluation.ts` bewertet Produktionscontroller auf Pflichtstufe, Kundenevent, Routing, Terminfreigabe, Fragen pro Turn, Wiederholungen, frühe Terminierung und Latenz.
- `worker/src/dialog-evaluation-scenarios.ts` enthält 38 realistische Positiv- und Negativszenarien für PKV-Fluss, Kundenereignisse, Routing, Termine und Qualitätsregeln.
- `npm run eval:dialogs` liefert einen reproduzierbaren Qualitätsbericht. Aktueller Stand: 38/38 Szenarien und 100/100 Punkte.
- Controller-Szenarien laufen gemeinsam mit den bestehenden Worker-Tests.

## Nächste Schritte

1. Anonymisierte echte Gesprächstranskripte in ein Replay-Format überführen und als zusätzliche Evaluationsfälle aufnehmen.
2. Kontrollierten Testanruf-Rollout mit Barge-in-, Latenz- und Terminmetriken durchführen.
3. Telnyx-Mark-Bestätigungen nutzen, um `audio_end_ms` nicht nur aus gesendeten Frames, sondern aus netzwerkseitig bestätigter Wiedergabe abzuleiten.
4. ElevenLabs Flash/Turbo gegen das aktuelle Modell mit echten Telefonaufnahmen hinsichtlich First-Chunk-Latenz, Zahlen- und Namensaussprache testen.
5. Freie OpenAI-Antworten erst nach einem kontrollierten Test satzweise an ElevenLabs weiterreichen; Tool-Calls, Unterbrechungen und Transkriptkonsistenz dürfen dadurch nicht überholt werden.
6. Alte, nicht mehr aktive Twilio-Pfade nach Produktionsprüfung entfernen.

## Qualitätskriterien

- Kein Termin vor Erfüllung aller fachlichen Voraussetzungen.
- Keine Zustimmung aus Füllwörtern, früheren Antworten oder ASR-Fragmenten ableiten.
- Höchstens eine Frage pro Turn.
- Kundenfragen und Einwände werden vor dem nächsten Pflichtschritt beantwortet.
- Nur tatsächlich bereitgestellte freie Termine dürfen bestätigt werden.
- Dialogszenarien, Typecheck und Build müssen vor jedem Rollout grün sein.