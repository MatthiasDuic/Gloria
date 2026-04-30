import type { CallReport, Lead, ScriptConfig } from "./types";

// ----- PKV ----------------------------------------------------------------
const PKV_PROOF = [
  "ZAHLEN & FAKTEN (verbindliche Vertriebs-Anker für Phase 5):",
  "",
  "BEITRAGSENTWICKLUNG GKV:",
  "- Die GKV-Beiträge passen sich seit Jahren im Schnitt um 4 bis 6 % jährlich an (effektiv über Beitragssatz, Zusatzbeitrag und Beitragsbemessungsgrenze).",
  "- Der durchschnittliche Zusatzbeitrag stieg von 1,1 % im Jahr 2020 auf voraussichtlich 2,5 % in 2025 – mehr als verdoppelt in nur fünf Jahren.",
  "- Wer heute 850 € GKV-Beitrag zahlt, ist bei 5 % p. a. in 10 Jahren bei rund 1.385 €, in 20 Jahren bei rund 2.255 €.",
  "",
  "BEITRAGSENTWICKLUNG PKV (Marktdurchschnitt):",
  "- Im langjährigen Schnitt sieht der Marktdurchschnitt in der privaten Krankenversicherung ähnlich aus: ca. 3 bis 5 % jährlich, in einzelnen Jahren auch 7 bis 10 % (Quelle: PKV-Verband).",
  "- Wer heute 600 € PKV-Beitrag zahlt, ist bei 4 % p. a. in 10 Jahren bei rund 890 €, in 20 Jahren bei rund 1.315 €.",
  "",
  "TARIFLANDSCHAFT:",
  "- Es gibt am Markt viele ältere PKV-Tarife mit unzureichenden Altersrückstellungen – also nicht ausreichend kalkulierte Reserven für die Beitragsentwicklung im Alter.",
  "- Nach Marktbeobachtungen haben rund 6 von 10 Bestandskunden Tarife, die seit vielen Jahren nicht mehr überprüft wurden – oft mit veralteten Leistungen oder ungünstiger Beitragskalkulation.",
  "- Beihilfe-Beamte zahlen typischerweise nur 30–50 % des PKV-Vollkostenbeitrags.",
  "- Selbstbehalt-Tarife reduzieren den Monatsbeitrag oft um 15–25 %.",
  "- GKV-Höchstbeitrag 2025: ca. 977 € plus Pflegeversicherung.",
  "",
  "NUTZUNGSREGEL: In Phase 5 (Problem-Aufbau) MUSS Gloria mindestens EINE konkrete Zahl aus diesem Block aktiv benennen, bevor sie in Phase 6 (Konzept-Übergang) wechselt. Zahlen werden mit Referenz-Phrasen wie \"laut PKV-Verband\", \"im Marktdurchschnitt\" oder \"nach unseren Beobachtungen\" eingeführt – niemals ohne Quelle.",
].join("\n");

const PKV_OBJECTIONS = [
  "EINWAND-BIBLIOTHEK (verbindliche Konter-Linien – Gloria nutzt diese als Basis, gekürzt auf 1–2 Sätze, in eigenen Worten):",
  "",
  "\"Kein Interesse\" → Genau das hören wir oft – und gerade deshalb lohnt sich eine kurze Einordnung. Die meisten Kunden merken erst beim nächsten Beitragsbescheid, dass sie hätten früher schauen sollen. Darf ich Ihnen das einmal in einem 15-Minütigen Termin zeigen?",
  "",
  "\"Schon versorgt\" → Das ist gut, denn dann hilft Ihnen unser Blick noch mehr: wir prüfen nicht, ob Sie versichert sind, sondern ob Ihr Tarif heute noch zukunftsfest kalkuliert ist. Viele ältere Tarife haben unzureichende Altersrückstellungen – das fällt erst spät auf.",
  "",
  "\"Zu teuer\" → Genau deshalb schauen wir gemeinsam drauf. Nicht der heutige Beitrag ist das eigentliche Thema – sondern wie er sich entwickelt. Und genau das ist planbar, wenn man früh genug die Stellschrauben kennt.",
  "",
  "\"Keine Zeit\" → Das verstehe ich. Es geht auch nicht um einen Vortrag, sondern um 15 Minuten mit Herrn Duic, in denen Sie eine belastbare Zahl für Ihre Beitragsentwicklung bekommen. Vormittag oder Nachmittag – was passt Ihnen besser?",
  "",
  "\"Rufen Sie nie wieder an\" → Selbstverständlich, ich notiere Sie sofort heraus. Darf ich Ihnen vorab nur kurz die Information per E-Mail zukommen lassen – damit Sie zumindest die Zahl zur Hand haben, falls Sie später doch noch Fragen haben?",
  "",
  "\"Zu jung / zu alt\" → Im Gegenteil: Je früher man die Beitragsentwicklung kennt, desto mehr Stellschrauben hat man. Und auch später im Berufsleben gibt es noch sinnvolle Optimierungen, gerade Richtung Ruhestand.",
  "",
  "\"Nur per Mail\" → Sehr gern als E-Mail-Bestätigung. Den Termin selbst möchte Herr Duic aber kurz persönlich mit Ihnen telefonieren, damit Sie ihm konkrete Fragen stellen können – das wäre fairer für Sie.",
  "",
  "\"Habe doch GKV\" → Auch in der GKV ist die Entwicklung relevant: der durchschnittliche Zusatzbeitrag hat sich von 1,1 % in 2020 auf 2,5 % in 2025 mehr als verdoppelt. Genau diese Entwicklung wollen wir Ihnen einordnen – unabhängig davon, ob GKV oder PKV.",
  "",
  "NUTZUNGSREGEL: Maximal ZWEI Einwände in Folge entkräften. Beim dritten Einwand höflich akzeptieren und höflich verabschieden.",
].join("\n");

const PKV_KNOWLEDGE = [
  "ERLAUBT zu sagen:",
  "- Beiträge in der PKV können sich planen lassen, indem man Tarif, Selbstbehalt und Beitragsentlastung sauber abstimmt.",
  "- Im Termin geht es um Einordnung, nicht um einen Abschluss.",
  "VERBOTEN zu sagen:",
  "- Konkrete Beitragsversprechen, garantierte Senkungen, Vergleiche zwischen einzelnen Gesellschaften ohne Daten.",
].join("\n");

// ----- bAV ----------------------------------------------------------------
const BAV_PROOF = [
  "- Arbeitgeber-Pflichtzuschuss zur bAV (Entgeltumwandlung): 15 % auf den umgewandelten Betrag.",
  "- Steuer- und sozialabgabenfrei bis 4 % BBG/West (2025: bis ca. 302 € monatlich).",
  "- Studien: Mitarbeiterbindung steigt nachweislich bei verständlich kommunizierter bAV (DIA-Studie 2023).",
  "- Häufige Modelle: Direktversicherung, Pensionskasse, Unterstützungskasse.",
].join("\n");

const BAV_OBJECTIONS = [
  'Haben wir schon: Sehr gut. Genau dann lohnt sich der Blick: viele Modelle laufen seit 2018 noch ohne den 15 %-Pflichtzuschuss – das wäre kurz zu prüfen.',
  'Mitarbeiter wollen das nicht: Das hören wir oft – meistens, weil das Modell zu komplex erklärt ist. Ein verständlicher Beratungsabend ändert das fast immer.',
  'Zu teuer für uns: Verstehe – tatsächlich ist die Entgeltumwandlung für den Arbeitgeber netto oft günstiger als reine Gehaltserhöhung, weil Sozialabgaben sinken.',
].join("\n");

const BAV_KNOWLEDGE = [
  "ERLAUBT: Konkrete Förderbeträge, allgemeine Modellunterschiede.",
  "VERBOTEN: Verbindliche Renditeversprechen.",
].join("\n");

// ----- bKV ----------------------------------------------------------------
const BKV_PROOF = [
  "- Arbeitgeber kann ab ca. 30 €/Monat pro Mitarbeitender nennenswerte Zusatzleistungen finanzieren (Zahnersatz, Sehhilfen, Vorsorge).",
  "- Steuerlich häufig als Sachbezug bis 50 €/Monat behandelbar.",
  "- Studien (z. B. PKV/Continentale): bKV verbessert Mitarbeiterbindung messbar, gerade in Engpassberufen.",
].join("\n");

const BKV_OBJECTIONS = [
  'Wir haben schon Benefits: Sehr gut – die bKV ergänzt die meisten Benefit-Pakete, weil sie konkret Geld zurück in die Familie bringt (Brille, Zahn). Darf ich es in 15 Minuten zeigen?',
  'Zu teuer: Verstehe. Wir sprechen über etwa 30 € pro Mitarbeiter – das ist meist günstiger als eine vergleichbare Bruttoerhöhung und bleibt netto vollständig beim Mitarbeiter.',
  'Mitarbeiter brauchen das nicht: Häufige Reaktion – aber sobald das Budget für die erste Zahnrechnung kommt, dreht sich die Stimmung. Dann ist es ein echter Bindungsfaktor.',
].join("\n");

const BKV_KNOWLEDGE = [
  "ERLAUBT: Förderlogik, Sachbezugsgrenzen.",
  "VERBOTEN: Versprechen zu individuellen Krankheitsfällen.",
].join("\n");

// ----- Gewerbe ------------------------------------------------------------
const GEWERBE_PROOF = [
  "- Bei Betriebshaftpflicht-Vergleichen sehen wir typische Beitragsdifferenzen von 15–30 % bei besserer Deckung.",
  "- Cyber-Schäden in KMU: durchschnittlich 95.000 € pro Vorfall (Allianz Risk Barometer 2024).",
  "- Inhaltsversicherung: Unterversicherung ist der häufigste Schadensfall-Streit (laut GDV).",
].join("\n");

const GEWERBE_OBJECTIONS = [
  'Sind gut versichert: Das hören wir oft – in 7 von 10 Fällen finden wir trotzdem eine Deckungslücke oder ein günstigeres Angebot bei gleicher Leistung.',
  'Habe keinen Bock auf Wechsel: Es geht erstmal nur um den Vergleich, kein Wechselzwang. Wenn nichts Besseres dabei ist, haben Sie Sicherheit, dass Sie gut aufgestellt sind.',
  'Zu wenig Zeit: Genau deshalb übernimmt Herr Duic den Vergleich für Sie – Sie geben uns 15 Minuten, wir machen die Arbeit.',
].join("\n");

const GEWERBE_KNOWLEDGE = [
  "ERLAUBT: Allgemeine Marktbeobachtungen, Deckungslücken-Beispiele.",
  "VERBOTEN: Konkrete Beitragsversprechen ohne Daten.",
].join("\n");

// ----- Energie ------------------------------------------------------------
const ENERGIE_PROOF = [
  "- Gewerbestrom-Spotmarkt schwankt typisch zwischen 8 und 18 Cent/kWh – Festpreis-Verträge können diese Schwankung glätten.",
  "- Viele Verträge laufen ungewollt in Standardtarife – oft 30–50 % teurer als Vergleichsangebot.",
  "- Reine Vergleichsanalyse ist kostenlos und unverbindlich.",
].join("\n");

const ENERGIE_OBJECTIONS = [
  'Habe ich erst gewechselt: Sehr gut – dann macht der Vergleich erst recht Sinn, weil wir prüfen, ob Sie nicht nach Vertragsende automatisch in einen teureren Tarif rutschen.',
  'Bringt eh nichts: Das hören wir oft – im Schnitt finden wir bei jedem zweiten Vergleich eine spürbare Ersparnis, vor allem bei Gas.',
  'Keine Zeit: Genau dafür sind wir da. 15 Minuten mit Herrn Duic, danach übernimmt er die Vergleichsarbeit für Sie.',
].join("\n");

const ENERGIE_KNOWLEDGE = [
  "ERLAUBT: Marktentwicklung, Vertragsanalyse.",
  "VERBOTEN: Konkrete Cent-Versprechen ohne Zählerdaten.",
].join("\n");

export const defaultScripts: ScriptConfig[] = [
  {
    id: "skript-bkv",
    topic: "betriebliche Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich melde mich im Auftrag von Herrn Matthias Duic. Es geht um die Frage, wie Unternehmen Mitarbeiterbindung und Arbeitgeberattraktivität heute spürbar stärken können.",
    discovery:
      "Mich würde kurz interessieren: Welche Benefits bieten Sie Ihren Mitarbeitenden heute schon an, und ist Mitarbeiterbindung bei Ihnen gerade ein wichtiges Thema?",
    objectionHandling:
      "Das kann ich gut nachvollziehen. Genau deshalb schauen viele Unternehmen zuerst ganz unverbindlich in 15 Minuten darauf, welche Modelle wirklich sinnvoll sind und was budgetseitig gut darstellbar wäre.",
    close:
      "Wenn Sie mögen, reserviere ich Ihnen direkt einen kurzen Termin mit Herrn Duic – passt Ihnen eher ein Vormittag oder ein Nachmittag besser?",
    knowledge: BKV_KNOWLEDGE,
    objectionResponses: BKV_OBJECTIONS,
    proofPoints: BKV_PROOF,
  },
  {
    id: "skript-bav",
    topic: "betriebliche Altersvorsorge",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an. Hintergrund ist, dass viele Arbeitgeber ihre betriebliche Altersvorsorge verständlicher und alltagstauglicher aufstellen möchten.",
    discovery:
      "Wie handhaben Sie die bAV aktuell bei neuen und bestehenden Mitarbeitenden, und gibt es dabei Punkte, die Sie gern einfacher oder attraktiver aufstellen würden?",
    objectionHandling:
      "Verstehe. Häufig reicht schon ein kurzer Blick von außen, um Fördermöglichkeiten, Arbeitgeberaufwand und die Verständlichkeit für Mitarbeitende deutlich besser einzuordnen.",
    close:
      "Gern würde ich Ihnen dafür einen kompakten Termin mit Herrn Duic reservieren – was passt bei Ihnen meist besser, eher Anfang oder eher Ende der Woche?",
    knowledge: BAV_KNOWLEDGE,
    objectionResponses: BAV_OBJECTIONS,
    proofPoints: BAV_PROOF,
  },
  {
    id: "skript-gewerbe",
    topic: "gewerbliche Versicherungen",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich melde mich im Auftrag von Herrn Matthias Duic. Viele Unternehmen prüfen ihre gewerblichen Versicherungen gerade noch einmal sauber auf Deckung, Beitrag und Risiko.",
    discovery:
      "Wann haben Sie Ihre gewerblichen Policen zuletzt in Ruhe verglichen – vor allem bei Betriebshaftpflicht, Inhalts- oder Cyberabsicherung?",
    objectionHandling:
      "Das ist absolut verständlich. Ein kurzer Vergleich zeigt oft schon, ob Deckungslücken bestehen oder ob Beiträge günstiger und Leistungen gleichzeitig besser darstellbar wären – ganz ohne direkten Wechselzwang.",
    close:
      "Wenn es für Sie passt, sichere ich Ihnen gern einen unverbindlichen Termin mit Herrn Duic – welcher Tag wäre dafür grundsätzlich angenehm?",
    knowledge: GEWERBE_KNOWLEDGE,
    objectionResponses: GEWERBE_OBJECTIONS,
    proofPoints: GEWERBE_PROOF,
  },
  {
    id: "skript-pkv",
    topic: "private Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich melde mich im Auftrag von Herrn Matthias Duic. Es geht um die Frage, wie sich Beiträge in der Krankenversicherung langfristig planbarer und stabiler aufstellen lassen.",
    discovery:
      "Darf ich kurz fragen: Sind Sie derzeit gesetzlich oder privat versichert, und ist das Thema Beitragsstabilität im Alter für Sie grundsätzlich interessant?",
    objectionHandling:
      "Das kann ich gut verstehen. Genau deshalb geht es im Termin nicht um einen schnellen Abschluss, sondern um eine kurze Einordnung, wie sich Beiträge langfristig besser planen lassen. Wenn Sie die Details gerade nicht parat haben, reicht zunächst auch die kurze Info, ob Sie sich derzeit grundsätzlich als gesund bezeichnen würden.",
    close:
      "Wenn es für Sie passt, reserviere ich Ihnen gern einen kurzen Termin mit Herrn Duic. Für die Vorbereitung klären wir dann nur noch ein paar Rahmendaten.",
    consentPrompt:
      'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".',
    pkvHealthIntro:
      "Damit wir den Termin optimal vorbereiten können, müssen wir kurz ein paar Basisinformationen abklären.",
    pkvHealthQuestions: [
      "Darf ich bitte zuerst Ihr Geburtsdatum aufnehmen?",
      "Könnten Sie mir bitte Ihre Körpergröße und Ihr aktuelles Gewicht nennen?",
      "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
      "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
      "Gibt es aktuell laufende Behandlungen oder bekannte Diagnosen, die wir berücksichtigen sollten?",
      "Nehmen Sie regelmäßig Medikamente ein, und wenn ja, welche?",
      "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
      "Gab es in den letzten zehn Jahren psychische Behandlungen?",
      "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
      "Bestehen bei Ihnen bekannte Allergien?",
    ].join("\n"),
    knowledge: PKV_KNOWLEDGE,
    objectionResponses: PKV_OBJECTIONS,
    proofPoints: PKV_PROOF,
  },
  {
    id: "skript-energie",
    topic: "Energie",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an. Viele Unternehmen schauen derzeit genauer auf ihre Strom- und Gaskonditionen, bevor unnötig Geld liegen bleibt.",
    discovery:
      "Wie zufrieden sind Sie aktuell mit Ihren gewerblichen Strom- und Gaskonditionen, und steht bei Ihnen in nächster Zeit eine Verlängerung oder Neuverhandlung an?",
    objectionHandling:
      "Verstehe gut. Genau deshalb nutzen viele Unternehmen einen kurzen Vergleich, um ohne großen Aufwand Transparenz über mögliche Einsparungen und bessere Konditionen zu bekommen.",
    close:
      "Wenn Sie möchten, organisiere ich Ihnen direkt einen kurzen Vergleichstermin mit Herrn Duic – wann würde es Ihnen zeitlich am besten passen?",
    knowledge: ENERGIE_KNOWLEDGE,
    objectionResponses: ENERGIE_OBJECTIONS,
    proofPoints: ENERGIE_PROOF,
  },
];

export const defaultLeads: Lead[] = [];

export const defaultReports: CallReport[] = [];
