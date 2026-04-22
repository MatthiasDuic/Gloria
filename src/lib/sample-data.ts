import type { CallReport, Lead, ScriptConfig } from "./types";

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
  },
];

export const defaultLeads: Lead[] = [];

export const defaultReports: CallReport[] = [];
