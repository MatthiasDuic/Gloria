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
| CRM-Kampagne sicher importieren | `/api/integrations/crm/campaigns` |
| Playbooks lesen/speichern | `/api/playbooks` |
| Stimmtest / Prompt-Vorschau | `/api/voice-preview` |
| Gesprächsreport von Telefonie empfangen | `/api/calls/webhook` |
| Telnyx-Testanruf starten | `/api/telnyx/test-call` |
| Telnyx-Anruf starten | `/api/telnyx/call` |
| Telnyx-Event-Webhook | `/api/telnyx/events` |
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

Wichtig: Die Admin-Seite und internen APIs sind geschützt. Die Telnyx-Callbacks für Telefonie bleiben bewusst erreichbar.

## CRM-Integration

Bei der telefonischen Terminvereinbarung fragt Gloria nach der Terminauswahl: **„Soll der Termin persönlich oder digital stattfinden?“** Bei einem digitalen Termin erklärt sie, dass der Berater den Link einen Tag vor dem Termin bereitstellt; ein Link wird nicht automatisch erzeugt. Für Master-Benutzer versendet Gloria die Terminbestätigung mit Kalendereinladung. Ein PDF-Terminbogen wird vorerst ausschließlich für das gemeinsame Thema **private Krankenversicherung** erstellt und angehängt. Betriebliche Krankenversicherung und persönliche Themen erhalten keinen PDF-Anhang; ihre Terminbestätigung bleibt möglich. Auch manuelle PDF-Exporte sind auf dieses PKV-Thema beschränkt, selbst wenn eine persönliche Kampagne von PKV kopiert wurde. Bei normalen Benutzern kündigt Gloria an, dass der Benutzer mit seinem im Profil hinterlegten vollständigen Namen die Bestätigung versendet; Gloria verschickt diese Kundenmail nicht selbst. Bereits eingeplante Terminmails werden vor dem Versand erneut anhand der Benutzerrolle geprüft. Interne Report-Mails bleiben davon unberührt. Neue Anrufe benötigen einen zugeordneten Benutzer mit hinterlegtem Namen; ohne diese Angaben werden sie nicht gestartet. Für diese Änderungen müssen sowohl die Web-Anwendung als auch der Telefonie-Worker deployt werden.

### Gesprächsstart, Warteschleifen und Wiedervorlagen

Die Audioerkennung startet parallel zum Laden des Gesprächsauftrags. Antworten bleiben bis zum erfolgreichen Laden dieses Auftrags gesperrt. Gloria wartet zu Beginn auf eine erkennbare menschliche Begrüßung oder Kontaktaufnahme, statt nach einem festen Schweigeintervall automatisch zu sprechen. Bei Warteschleifen und Weiterleitungen bleibt sie stumm, bis sich ein Mensch meldet. Wiederholte Ansagen verlängern die maximale Kontakt-Wartezeit von **drei Minuten** nicht. Mailboxhinweise werden auch nach einer zunächst menschlich wirkenden Begrüßung oder bestätigter Zuständigkeit geprüft. Die Erkennung beruht auf transkribierten Ansagen und Kontaktmerkmalen; sie ist keine garantierte akustische Unterscheidung jeder beliebigen Aufnahme von einem Menschen.

Wenn die Zielperson nicht da ist und der Empfang eine Rückrufnummer erfragt, nennt Gloria die **reale Rufnummer des jeweiligen Benutzers** aus dessen Benutzerkonto, nicht die Nummer des angerufenen Kontakts. Sie liest die Ziffern einzeln vor, wartet bei Bedarf auf Mitschreibbereitschaft und wiederholt die Nummer auf Wunsch. Ohne gültig hinterlegte reale Rufnummer sagt sie, dass sie nicht vorliegt, statt eine Nummer zu erfinden.

Nach einer erkannten Mailbox wird ohne Nachricht aufgelegt und der Anruf als „Nicht erreicht / kein Kontakt“ dokumentiert. Die automatische Wiedervorlage bleibt begrenzt: nach Versuch eins in einem Tag, nach Versuch zwei in drei Tagen, nach Versuch drei keine weitere automatische Wiederholung. Auch manuelle Mailboxanrufe erhalten einen dauerhaft gespeicherten Rückrufkontakt. Automatische Wiederanrufe beachten weiterhin Anrufzeiten und bei CRM-Kampagnen deren Aktivierung. Derselbe erneut übermittelte Abschlussbericht erhöht die Versuche nicht und verschiebt die Wiedervorlage nicht.

Im fachlichen Gespräch verwendet der Worker semantische Sprecherwechsel-Erkennung mit niedriger Eagerness; für die erste Kontaktaufnahme bleibt die schnellere, bestehende Server-VAD aktiv. Fortgesetzte Kundensätze und noch ausstehende Transkriptteile blockieren Antworten. Mehrteilige Aussagen werden vollständig und in Sprechreihenfolge übernommen. Kundensprache kann auch eine gerade begonnene Antwort unterbrechen. Die Logs `realtime.session_ready`, `realtime.topic_policy_applied`, `realtime.user_turn_processing` und `realtime.start_latency` trennen Initialisierung, Auftragsladen, Transkript-Wartezeit und erste TTS-Ausgabe. Produktionslatenz und Erkennungsqualität müssen mit neuen Telefonaten geprüft werden; synthetische Tests messen keine Providerlatenz.

### Eigene Themen dauerhaft anlegen

„Anlegen“ speichert das neue persönliche Thema sofort serverseitig, nicht nur als Browser-Entwurf. Das gilt für Master und normale User; eigene Themen gehören jeweils dem anlegenden Konto. Gesprächsauftrag und Leitfaden können anschließend ergänzt und gespeichert werden; ohne Auftrag darf noch kein Anruf gestartet werden. Mit konfigurierter Datenbank wird die Speicherung in `user_playbooks` zurückgelesen und bestätigt. Ein erneutes Login lädt diese persönlichen Themen zusammen mit den gemeinsamen Themen; sie sind auch in der Kampagnen- und Stimmenauswahl verfügbar. Die Schema-Initialisierung bei Neustarts und Deployments löscht weder eigene Themen noch deren Freigaben. In Vercel ist für dauerhafte Speicherung PostgreSQL erforderlich; ein Datenbankfehler wird nicht als erfolgreicher Datei-Fallback bestätigt. Bereits zuvor gelöschte Inhalte werden dadurch nicht wiederhergestellt.

CRM-Kampagnen werden serverseitig über `/api/integrations/crm/campaigns` mit dem Header `x-gloria-integration-token` importiert. Setze `GLORIA_CRM_INTEGRATION_TOKEN` auf denselben geheimen Transportwert wie im CRM und verwalte ihn ausschließlich über die Secret-Verwaltung des Deployments. Eine feste `GLORIA_CRM_USER_ID` wird nicht mehr verwendet: Nutzer verbinden ihr eigenes Konto über „Profil / CRM-Verbindung“ und geben dort die CRM-Backend-Adresse sowie den persönlichen API-Schlüssel ein. Gloria validiert diesen Schlüssel beim CRM; das CRM bindet ihn an die angemeldete Gloria-Benutzer-ID. Der Schlüssel wird in Gloria nicht gespeichert. Bei einem Import wird der gepaarte Benutzer aus dieser serverseitigen Bindung ermittelt, nicht aus einer frei gelieferten Ziel-ID. Importierte CRM-Listen bleiben inaktiv und haben zunächst kein Gesprächsthema. Beim Start wählen Nutzer eine ihrer vorhandenen Kampagnen; deren Thema wird erst dann den Kontakten der Liste zugewiesen. Der vollständige CRM-Firmendatensatz wird in der Lead-Akte gespeichert; ein begrenzter Gesprächskontext steht Gloria beim Telefonat zur Verfügung.

Die PostgreSQL-Speicherung der Kontakte verwendet Schreibblöcke von maximal 100 Datensätzen innerhalb einer gemeinsamen Transaktion statt eines einzelnen Datenbankaufrufs pro Kontakt. Das reduziert die Datenbank-Roundtrips bei mehrteiligen CRM-Übertragungen; bei einem Schreibfehler wird die gesamte Speicherung dieses Abschnitts zurückgerollt. Wiederholte Übertragungen derselben CRM-Liste gleichen die Firmen über ihre CRM-ID ab, statt sie erneut anzulegen.

Firmenlisten haben keine feste Grenze von 300 Firmen: Das CRM überträgt größere Listen in Abschnitten von höchstens 100 Firmen (zusätzlich größenbegrenzt). Die Regressionstests prüfen 650 Firmen in sieben Abschnitten einschließlich einer wiederholten Übertragung des dritten Abschnitts. Ein produktiver Transfer bleibt von Netzwerk- und Plattformlaufzeiten abhängig.

Im Gloria-CRM lädt **„Aktualisieren“** Kontakte, Reports und Firmenlisten ohne Seitenwechsel neu. Ansprechpartner werden in der Firmenübersicht und der Kontaktakte als Liste mit vorhandenen individuellen Geburtsdaten angezeigt; unbekannte Geburtsdaten bleiben leer. Vor dem Start einer übertragenen Firmenliste wird deren aktueller Datenstand geladen. Im Startdialog wählen Nutzer das Thema und für jede Firma mit mehreren Ansprechpartnern mindestens eine Person aus. Bei einer einzigen Person erfolgt die Übernahme automatisch; Firmen ohne namentlichen Ansprechpartner behalten einen allgemeinen Firmenkontakt. Der Server prüft die Auswahl erneut gegen die Firmenliste des angemeldeten Benutzers und erstellt nur für die gewählten Personen Anrufkontakte mit dem jeweils zugehörigen Geburtsdatum. Die Quellliste und der vollständige CRM-Snapshot bleiben unverändert als Hintergrundwissen erhalten. Fortgesetzte Kampagnen verwenden die bereits gespeicherten Anrufkontakte.

In einer importierten Firmenakte lassen sich bearbeitete Firmendaten über **„Firmendaten in CRM abgleichen“** gezielt zurückschreiben. Gloria-Gesprächsnotizen und vereinbarte Gesprächstermine werden bei CRM-Firmen automatisch an das gekoppelte CRM-Konto übertragen. Team- und Feldberechtigungen im CRM bleiben maßgeblich; die Vertriebs-Pipeline wird in Gloria nicht angezeigt.

Über jeder Kontakttabelle zeigt eine beim Scrollen sichtbare Auswahlleiste die Anzahl markierter Einträge. Kontakte lassen sich einzeln per Checkbox oder über **„Alle angezeigten auswählen“** markieren und nach Bestätigung mit **„Ausgewählte löschen“** gemeinsam entfernen. Die Aktion berücksichtigt ausschließlich markierte Kontakte der aktuell gefilterten Ansicht; ausgeblendete Markierungen werden nicht mitgelöscht. **„Auswahl aufheben“** entfernt alle Markierungen. Gelöscht wird nur in Gloria, nicht in der Firmendatenbank; Gesprächsreports bleiben erhalten.

Die Daten-Spalten der Kontakttabelle lassen sich per Klick auf ihre Überschrift aufsteigend und mit erneutem Klick absteigend sortieren. Ein Pfeil kennzeichnet die aktive Sortierung. Texte verwenden deutsche, nicht zwischen Groß- und Kleinschreibung unterscheidende natürliche Sortierung; Mitarbeiter-, Produkt- und Anrufzahlen werden numerisch sortiert. Leere Werte stehen in beiden Richtungen am Ende. Die Sortierung verändert weder die Daten noch die Auswahl der markierten Kontakte und bleibt beim Aktualisieren innerhalb der geöffneten CRM-Ansicht erhalten.

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
OPENAI_MODEL=gpt-4.1
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
```

Die laufende turn-basierte Gesprächslogik nutzt `OPENAI_MODEL` (empfohlen: `gpt-4.1` für stabile Live-Latenz). `OPENAI_REALTIME_MODEL` ist nur für zukünftige Realtime-Erweiterungen hinterlegt und wird im aktuellen Worker-Flow nicht für die Audioausgabe verwendet.

## ElevenLabs-Stimme aktivieren

Trage zusätzlich in `.env` deine ElevenLabs-Daten ein:

```env
ELEVENLABS_API_KEY=dein_api_key
ELEVENLABS_VOICE_ID=deine_voice_id
ELEVENLABS_MODEL=eleven_v4_turbo
ELEVENLABS_FALLBACK_MODEL=eleven_multilingual_v2
ELEVENLABS_STABILITY=0.4
ELEVENLABS_SIMILARITY=0.88
ELEVENLABS_STYLE=0.3
ELEVENLABS_SPEED=0.97
ELEVENLABS_SPEAKER_BOOST=true
ELEVENLABS_LATENCY_MODE=3
```

Telefonanrufe verwenden v4 Turbo über die Text-to-Dialogue-WebSocket. Normale KI-Antworten werden satzweise gesprochen, sobald ein Satz vollständig ist. Bei einem Fehler vor dem ersten Audiopaket nutzt der Worker `ELEVENLABS_FALLBACK_MODEL`. Der Dashboard-Button **„Stimme testen“** und die Preflight-Prüfung verwenden weiterhin den HTTP-kompatiblen Fallback (standardmäßig Multilingual v2). Style, Speed und Speaker Boost gelten nur für diesen Fallback; v4 Turbo nutzt Stability und Similarity.

## Telnyx direkt anbinden

Wenn du bereits einen **Telnyx-Account** hast, ist Gloria auf direkte Testanrufe vorbereitet.

Trage in `.env.local` ein:

```env
APP_BASE_URL=https://deine-oeffentliche-url.de
TELNYX_API_KEY=dein_telnyx_api_key
TELNYX_CONNECTION_ID=deine_connection_id
TELNYX_PHONE_NUMBER=+49XXXXXXXXXX
TELNYX_MEDIA_STREAM_URL=wss://dein-render-worker.onrender.com/telnyx-stream
```

Danach:

1. lokalen Server starten: `npm run dev`
2. öffentliche URL bereitstellen, z. B. `cloudflared tunnel --url http://localhost:3000` oder `ngrok http 3000`
3. diese URL als `APP_BASE_URL` in `.env.local` setzen
4. im Dashboard unter **„Live-Testanruf“** eine Zielnummer eingeben und den Anruf starten

Telnyx nutzt dann diese Endpunkte:

- `/api/telnyx/call` – startet den Anruf via Telnyx API
- `/api/telnyx/events` – verarbeitet Telnyx-Status- und Stream-Events
- `/api/calls/webhook` – nimmt aggregierte Gesprächsergebnisse entgegen

## Live-Gespräche mit Render-Worker

Gloria läuft im Live-Flow über den Render-Worker stabil im turn-basierten Sprachfluss:

- Telnyx Media Streams für Audio in Echtzeit
- OpenAI Chat Completions für Antwortentscheidungen
- ElevenLabs für Audioausgabe

Der Worker-Endpunkt wird über `TELNYX_MEDIA_STREAM_URL` angebunden.

## CRM-Arbeitsbereiche

- **Dashboard:** Schnellzugriffe auf alle Bereiche, heutige Termine und Wiedervorlagen, offene Aufgaben und Termin-Interessenten zur Übernahme.
- **Kampagnen:** Die Reiter **Anruflisten**, **Termin-Interessenten** und **Follow-ups** bündeln CSV-/Excel-Import, Start/Stopp der Telefonie und offene Rückrufe. Ein importierter Kontakt bleibt Interessent, bis er ausdrücklich als Kunde übernommen wird.
- **Firmenkunden:** Bestand bestätigter Firmenkunden. Firmenakten zeigen Unternehmen und Ansprechpartner. Privatkunden werden im Gloria-CRM nicht angezeigt. Manuelle Firmenkunden werden ohne vorausgewähltes Gesprächsthema angelegt und nicht als Anrufkampagnen gestartet.
- **Kontaktakte:** Stammdaten, Produkte und Anträge, Aufgaben und Notizen, Historie sowie Kommunikation sind in Reitern erreichbar, auch direkt aus Kalender und Pipeline.
- **Gemeinsamer Kalender:** Hauptbereich und CRM verwenden dieselbe Kalenderkomponente und zeigen die Termine und Wiedervorlagen beider Anrufbereiche des angemeldeten Benutzers an. Die Outlook-inspirierte Darstellung bietet Tag, Woche, Arbeitswoche (Montag bis Freitag) mit Stundenraster, Monat und eine monatsbezogene Agenda. Wochen beginnen montags; Vor/Zurück navigiert passend zur Ansicht, „Heute“ springt zum aktuellen Zeitraum. CRM-Termine erscheinen blau, **Analoge Termine** (einschließlich eigener Folgetermine) olivgrün, Wiedervorlagen bzw. geplante Gloria-Aufgaben orange und **Sperrzeiten magenta**. Über „Neuer Eintrag“ lassen sich Folgetermine oder Sperrzeiten mit Titel/Kunde und Notiz erstellen, bearbeiten und löschen. Sperrzeiten haben frei wählbare Anfangs- und Endzeiten und können mehrere Tage umfassen. Die Einträge werden benutzerspezifisch in PostgreSQL gespeichert; lokal ohne Datenbank in einer separaten Kalenderdatei. Sie erzeugen keine Anrufreports oder Kampagnenkontakte. Das Stundenraster zeigt überlappende Reservierungen nebeneinander und blockiert pro Termin **90 Minuten inklusive An- und Abreise**, unabhängig von der tatsächlichen Gesprächsdauer. Gloria berücksichtigt CRM-Termine, analoge Termine, Folgetermine und Sperrzeiten, auch bereits begonnene noch aktive Reservierungen. Es gibt kein Tageslimit für Termine; die Auswahl angebotener Zeitvorschläge ist keine Kapazitätsgrenze. Vor jeder Bestätigung wird die Verfügbarkeit erneut geprüft, auch bei Kundenwunschzeiten; bei Kalenderfehlern wird kein Termin bestätigt. Wiedervorlagen selbst reservieren keinen Besuchstermin. Rückrufzeiten stammen aus dem aktuellen Kontaktstand, nicht aus veralteten Gesprächsberichten. Termin-Dubletten werden innerhalb ihrer Herkunft zusammengeführt, niemals zwischen CRM und manuellen Anrufen.
- **Follow-ups:** Erledigen entfernt eine Wiedervorlage aus der offenen Planung; Verschieben setzt den neuen Zeitpunkt. Automatische Anrufe bleiben an die konfigurierten Anrufzeiten gebunden.
- Kunden werden nicht erneut als neue Kampagnenkontakte gewählt; beim Löschen einer Kampagne bleiben übernommene Kunden erhalten.
- **Anrufbereiche:** Kampagnenanrufe, CRM-Wiedervorlagen und Gloria-Aufgaben erscheinen ausschließlich im CRM (Kampagnen → Gesprächsreports, Anrufdetails je Liste und Kontaktakte → Historie). „Anrufe“ dokumentiert nur manuelle Einzel-/Testanrufe und deren Rückrufe. Die Herkunft wird mit dem Report und dem Rückrufkontakt gespeichert; gleiche Firmennamen verbinden die Bereiche nicht.
- Manuelle Wiedervorlagen bleiben unter „Anrufe“ und sind unabhängig vom Kampagnenstatus automatisch fällig (weiterhin innerhalb der konfigurierten Anrufzeiten). Nur die Kalenderansichten und der Kalenderfeed führen CRM- und analoge Einträge zusammen; Anruflisten, Kundenbestand und Gesprächsreports bleiben getrennt. Der Feed kennzeichnet CRM-Termine blau, analoge Termine olivgrün, Wiedervorlagen orange und Sperrzeiten magenta; die Darstellung dieser ICS-Farben hängt vom abonnierenden Kalenderprogramm ab. „Manuelle Reports löschen“ lässt CRM-Reports unverändert. Änderungen an der Terminprüfung benötigen neben dem Web-Deployment auch ein separates Worker-Deployment.
- Bestehende Reports mit Kontakt-ID werden dem CRM zugeordnet, bekannte Test-/manuelle Reports dem manuellen Bereich. Reports ohne Kontakt-ID und ohne eindeutige Kampagnenkennzeichnung bleiben im manuellen Bereich; es erfolgt keine unsichere Zuordnung anhand des Firmennamens.

## Automatische Telefonie

Für **echte autonome Telefonate über euren Telefonanschluss** brauchst du zusätzlich einen Voice-/Telefonie-Provider, z. B.:

1. **Telnyx** für Rufnummer, Anrufe, Events und Streaming
2. den **Render-Worker** für dauerhafte WebSocket-Verbindungen
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
| `OPENAI_API_KEY` | Live-Antworten im Telefonie-Gesprächsfluss |
| `OPENAI_MODEL` | Empfohlen: `gpt-4.1` |
| `TELNYX_API_KEY` | Telnyx API-Zugang |
| `TELNYX_CONNECTION_ID` | Telnyx Voice Connection für Outbound Calls |
| `TELNYX_PHONE_NUMBER` | Ausgehende Telnyx-Rufnummer |
| `TELNYX_MEDIA_STREAM_URL` | WSS-URL des Render-Workers (`.../telnyx-stream`) |
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
| `ELEVENLABS_MODEL` | ElevenLabs-Modell überschrieben werden soll |
| `ELEVENLABS_FALLBACK_MODEL` | bei einem v4-Turbo-Fehler der kompatible HTTP-Fallback genutzt wird |
| `ELEVENLABS_PREVIEW_MODEL` | ein abweichendes HTTP-Modell für den Dashboard-Stimmtest gesetzt werden soll |
| `ELEVENLABS_STABILITY` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SIMILARITY` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_STYLE` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SPEED` | ElevenLabs-Voice-Tuning genutzt wird |
| `ELEVENLABS_SPEAKER_BOOST` | ElevenLabs-Voice-Tuning genutzt wird |
| `MEDIA_STREAM_WSS_URL` | optionaler Legacy-Fallback für Stream-URL |
| `TELNYX_API_BASE_URL` | nur bei abweichender Telnyx-API-Basis notwendig |
| `LIVE_AI_TIMEOUT_MS` | OpenAI-Timeout vom Standard abweichen soll |

### 3) Empfohlene Belegung für Preview

- Setze mindestens: `APP_BASE_URL`, `BASIC_AUTH_USERNAME`, `BASIC_AUTH_PASSWORD`.
- Für sichere Tests mit echter Telefonie setze zusätzlich Telnyx + OpenAI Variablen.
- Wenn Preview ohne echte Calls laufen soll, lasse Telnyx/ElevenLabs leer.

### 4) Schnell-Check nach dem Setzen

1. In Vercel Deployments neu ausrollen (`Redeploy`), damit neue Variablen aktiv sind.
2. Health prüfen: `GET /api/health`.
3. Dashboard öffnen und Testlauf machen:
  - Stimmtest
  - Telnyx-Testanruf
  - Report entsteht im Dashboard
4. Outlook-Export prüfen: `GET /api/export/outlook`.

### 5) Beispielwerte (Production)

```env
APP_BASE_URL=https://gloria-ki-assistent.vercel.app
OPENAI_MODEL=gpt-4.1
TELNYX_MEDIA_STREAM_URL=wss://gloria-stream-worker.onrender.com/telnyx-stream
LIVE_AI_TIMEOUT_MS=1000
```
