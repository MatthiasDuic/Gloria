# Neuaufbau des Gesprächskerns

## Zielarchitektur

Der Gesprächskern wird schrittweise in drei klar getrennte Bereiche aufgeteilt:

1. **Transport:** Telnyx Media Stream, OpenAI-Realtime-Verbindung und Audio-Pufferung.
2. **Conversation Controller:** deterministische Zustände, Pflichtschritte und Tool-Freigaben.
3. **Formulierung:** natürliche deutsche Antworten innerhalb der vom Controller gesetzten Grenzen.

Fachliche Voraussetzungen dürfen nicht allein durch Prompttexte oder das Sprachmodell geprüft werden.

## Auftragstreue im Live-Gespräch

- Bietet der Empfang das Verbinden an, bestätigt Gloria das Angebot kurz, statt erneut darum zu bitten. Eine bereits laufende Weiterleitung oder Warteschleife bleibt stumm; erst nach einer neuen menschlichen Äußerung stellt Gloria sich bei Bedarf erneut vor und prüft eine unklare Identität. Ein einfaches „Ja“ auf Glorias Weiterleitungsbitte startet die Wartephase. Bei Rückfragen nennt sie den tatsächlichen Kampagnenanlass knapp, ohne die Weiterleitungsfrage zu wiederholen. Die bestehende Sicherheitsgrenze für unbeantwortete Warteschleifen beträgt weiterhin drei Minuten.

- Bei ausdrücklichem Wunsch nach einem Menschen oder Ablehnung des Gesprächs mit Gloria/KI wird an die reale Rufnummer des jeweiligen Auftraggebers weitergeleitet. Der Worker übergibt die Benutzer-ID; die authentifizierte Transfer-API liest und validiert die Rufnummer aus dem Benutzerkonto. Es gibt kein globales oder fest codiertes Ersatzziel. Fehlende Rufnummern und Telnyx-Fehler werden nicht als erfolgreiche Weiterleitung gemeldet; Gloria bietet stattdessen einen Rückruf an. Allgemeine Ablehnung und fehlendes Interesse führen weiterhin nicht zur Weiterleitung.

- Eigene Kampagnen lassen sich auch als noch nicht gespeicherte Entwürfe löschen. Entwürfe werden lokal entfernt, gespeicherte Kampagnen erst nach erfolgreicher API-Bestätigung. Andere offene Entwürfe, Kontakte und Anrufreports bleiben erhalten; Standardthemen sind weiterhin vor dem Löschen geschützt.

- Nach Vorstellung und Gesprächszusage verbindet eine kurze, zugewandte Überleitung den konkreten Anlass mit dem Alltag der Person, bevor eine offene Themenfrage folgt. Kein direkter Sprung zu Beitrag, Versicherung oder Termin; keine wiederholte Vorstellung oder Erlaubnisfrage. Dafür sind höchstens zwei kurze Sätze und eine Hauptfrage vorgesehen. Kundenfragen, Zeitmangel, Ablehnung und der bekannte Rückrufstand bleiben vorrangig.
- Der gespeicherte „Auftrag für Gloria“ wird vollständig und ohne Kürzung der Zeilen oder Zeichen in den Gesprächskontext übernommen.
- Bei vorhandenem Auftrag ist der Kampagnenname nur eine interne Zuordnung. Der Entscheider-Einstieg wird mit transparenter KI-Identität und dem tatsächlichen Anlass aus dem Auftrag formuliert, statt den Kampagnennamen als Thema vorzulesen.
- Das gilt für reguläre Anrufe, Testanrufe und Rückrufe. Der bisherige Gesprächsstand bleibt bei Rückrufen erhalten; offene Auftragsschritte werden situationsgerecht fortgesetzt.
- Jede frei formulierte Antwort wird an die Auftragstreue erinnert. Kundenfragen, Rückrufwünsche, Datenschutz, Freiwilligkeit und klare Ablehnungen bleiben vorrangig.
- `response.instructions` ersetzt bei OpenAI Realtime die Session-Anweisungen. Deshalb enthält jede Antwortanweisung den vollständigen aktuellen Systemkontext einschließlich Auftrag und Fachwissen, gefolgt von der Anweisung für den konkreten Turn. Ein Verweis auf den Auftrag allein reicht nicht.
- Eine Zusage zu einem kurzen Gespräch ist keine Terminfreigabe. Anlass, Relevanz, Bedarfsfragen und der im Auftrag vorgesehene Ausblick/Lösungsansatz gehen der Terminfrage voraus. Interne Promptbegriffe dürfen nicht als Gesprächsanlass ausgesprochen werden.
- Ohne hinterlegten Auftrag bleibt der bisherige kampagnenbezogene Einstieg erhalten. Die Änderung benötigt ein separates Worker-Deployment.
- Die vom Backend geprüften freien Kalender-Slots stehen im Session- und Antwortkontext zur Verfügung. Eine nachträglich geladene Kalenderliste aktualisiert die Session; Kundenwunschzeiten werden vor jeder Bestätigung erneut gegen den Kalender geprüft.
- Numerische und ausgeschriebene Terminparameter des Modells werden auf denselben kanonischen Kalendereintrag abgebildet; beispielsweise sind `8:30 Uhr`, `08:30 Uhr` und `acht Uhr dreißig` derselbe Zeitpunkt. Die Antwort „digital“ wird als Microsoft-Teams-Termin erkannt.
- Nach der Zeitpräferenz bietet der Controller zwei echte Kalender-Slots an und hält eine Auswahl wie „der Dienstag“ als vollständigen Slot fest. Die Durchführungsart bleibt auch bei weiteren Gesprächszügen erhalten. Jeder Tool-Aufruf wird nur einmal verarbeitet; parallele Buchungsversuche werden gesperrt.
- Die beiden angebotenen Optionen liegen mindestens zwei Kalendertage auseinander, haben unterschiedliche Wochentage und unterschiedliche Uhrzeiten innerhalb der gewünschten Tageshälfte. Die verdichtete Kalenderliste erhält verschiedene Uhrzeiten, statt durch gleichmäßige Stichproben immer denselben Tagesanfang auszuwählen. Gibt es kein passendes Paar, fragt Gloria nach einem anderen Zeitraum; Kundenwunschtermine und bereits getroffene Auswahlen bleiben zulässig.
- Vor der hörbaren Terminbestätigung wird die Verfügbarkeit erneut geprüft und der Termin über den inkrementellen Report-Webhook gespeichert. Eine HTTP-Erfolgsmeldung reicht nicht: Die Antwort muss den gespeicherten Termin mit Ergebnis „Termin“ und korrektem Zeitpunkt enthalten. Erst danach startet die freiwillige Vorbereitung. Dieser Schritt verschickt noch keine Abschluss-E-Mail; die vollständige Auswertung nach Gesprächsende aktualisiert denselben Report per Call-ID.
- Die inkrementelle Buchungsspeicherung benötigt das Web-Deployment zusätzlich zum Worker-Deployment. TypeScript-Testdateien werden über den Test-Runner geprüft und sind vom Produktions-Build ausgeschlossen.
- Fehlende Uhrzeiten werden nicht mehr als Mitternacht interpretiert. Numerische Zeitangaben ohne „um“ oder „Uhr“ werden akzeptiert. Unverständliche Aussagen dürfen keine erfundene Zustimmung oder Planung auslösen.
- Bei einem Auftrag mit Zehn-Jahres-Ausblick erzeugt der Worker die Beispielrechnung unmittelbar aus der Antwort zum heutigen Monatsbeitrag: vier Prozent jährlich mit Zinseszins, auf fünf Euro gerundet. Einstiegsbeiträge werden nicht verwendet. Bei 480 Euro ergibt das rund 710 Euro monatlich in zehn Jahren, also rund 230 Euro mehr. Danach folgt der konkrete Konzeptnutzen aus dem Auftrag, ohne Ergebnisversprechen.
- Der Standard-Transkriptionshinweis wird bei ASR-Leakage ignoriert und löst bei unterbrochener Ausgabe eine akustische Rückfrage aus. Eine menschliche Übergabe setzt einen tatsächlichen Kundenwunsch voraus; sie ersetzt keine Terminprüfung.

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
- Mehrteilige deutsche Beitragsangaben wie „tausend zweihundert Euro“ werden als vollständiger Betrag erkannt und bilden die korrekte Hochrechnungsbasis.
- Ausgeschriebene Geburtsdaten wie „zwölfter Juli neunzehnhundertvierundsiebzig“ werden akzeptiert. Nach drei unplausiblen Antworten überspringt Gloria eine Vorbereitungsfrage, statt sie endlos zu wiederholen.
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
- Schnelle Begrüßung: Ist der erste Sprachabschnitt nicht zu lang (z. B. „Hallo?“, „Ja, Müller?“ oder „Neumann am Apparat, guten Tag.“, standardmäßig höchstens 4500 ms inklusive VAD-Stille, konfigurierbar über `OPENING_SPECULATION_MAX_TURN_MS`, `0` deaktiviert), beginnt Gloria sofort mit dem neutralen Vorstellungssatz, während die Transkription noch läuft. Die passende Folgefrage (Personenbestätigung, Bitte um Verbindung oder Gesprächsanlass) wird ohne erneute Vorstellung angehängt. Erkennt die Transkription eine Warteschleife oder einen Anrufbeantworter, wird der Satz sofort abgebrochen und aus dem Transkript entfernt. Spricht der Angerufene weiter, wird der Satz ebenfalls verworfen und nach dem vollständigen Turn erneut gesprochen.
- Vorproduzierter Gesprächseinstieg: Sobald die Gesprächsrichtlinie geladen ist, synthetisiert der Worker während des Klingelns sowohl die Vorstellung (`realtime.identity_prefetched`) als auch den ersten thematischen Satz (`realtime.topic_prefetched`). Nach der Begrüßung werden beide ohne weitere OpenAI-Antwortgenerierung direkt nacheinander abgespielt. Ein natürlich formulierter erster Satz aus dem Gesprächsauftrag wird übernommen; bei internen Anweisungen wird sicher auf „Ich rufe zum Thema … an“ zurückgegriffen. `gloria_said` mit `deterministic: true` protokolliert den thematischen Satz. Die Vorab-Erzeugung kostet grob 180–300 TTS-Zeichen pro gewähltem Anruf, auch ohne Annahme. Abschaltbar mit `ELEVENLABS_IDENTITY_PREFETCH=false`.
- Erste Sprechpause: Bis zum ersten Kontakt gilt eine kürzere VAD-Stille von `OPENING_SILENCE_MS` (Standard 350 ms), damit Gloria nach „Ja, Müller?“ schneller einsetzt. Danach gelten wieder die normalen, geduldigeren Werte.
- Keine Zeit / Rückruf: Sagt der Angerufene, dass es gerade schlecht passt („Gerade ist es schlecht“, „Ich habe keine Zeit“, „Bin im Termin“), fragt Gloria fest formuliert genau einmal „Kein Problem. Wann passt es Ihnen besser?“. Den genannten Zeitpunkt („morgen Vormittag“, „gegen 11 Uhr“) übernimmt sie ohne Rückfrage und verabschiedet sich: „Vielen Dank für das Gespräch. Dann melde ich mich wie besprochen … noch einmal bei Ihnen. Einen schönen Tag noch und auf Wiederhören.“ Danach legt sie auf. Nennt der Angerufene den Zeitpunkt gleich mit, entfällt die Frage. Ohne konkrete Angabe fragt sie höchstens einmal nach und verabschiedet sich dann allgemein. Die Wiedervorlage wird im Abschlussbericht gesetzt (`realtime.callback_flow` im Log).
- Digitale Telefonassistenten: Begrüßungen wie „Herzlich willkommen … Ich bin die digitale Assistentin … Wie lautet Ihr Name und wie kann ich Ihnen weiterhelfen?“ gelten nicht als Warteschleife, sondern als Vorzimmer. Gloria stellt sich vor und bittet um Verbindung. Enthält die Ansage zusätzlich eindeutige Warteschleifenhinweise („Bitte warten Sie“, „Drücken Sie die 1“), wartet Gloria weiter.
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
- Gloria stellt sich als „digitale Vertriebsassistentin“ vor und beantwortet Rückfragen nach ihrer KI-Identität offen.
- Bei einem Gesundheitskostenauftrag mit Zehn-Jahres-Ausblick erzwingt der Controller vor der Terminierung die Frage nach dem heutigen Beitrag und die tatsächlich gesprochene Rechnung. Ein allgemeiner Hinweis auf steigende Kosten genügt nicht. Bei freiwillig übersprungener oder unbekannter Angabe bleibt eine ausdrücklich allgemeine Beispielrechnung möglich; andere Kampagnen erhalten diese Pflicht nicht.
- Der Kundenterminbogen erkennt auch die Beitragsfrage aus dem Erstgespräch („Welchen monatlichen Beitrag zahlen Sie aktuell …?“). Er übernimmt ausschließlich die dazugehörige Kundenantwort, nicht den hochgerechneten Betrag oder spätere sachfremde Antworten. Dies gilt für separate Transkriptereignisse und das eingebettete Protokoll; eine frühere Angabe wird bei übersprungener Wiederholungsfrage nicht verloren.