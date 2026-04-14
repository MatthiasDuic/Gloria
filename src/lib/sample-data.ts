import type { CallReport, Lead, ScriptConfig } from "./types";

export const defaultScripts: ScriptConfig[] = [
  {
    id: "skript-bkv",
    topic: "betriebliche Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich hoffe, ich störe Sie gerade nicht. Viele Unternehmen nutzen die betriebliche Krankenversicherung inzwischen gezielt, um Fachkräfte leichter zu gewinnen und zu binden. Bevor wir starten: Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Mich würde kurz interessieren: Welche Benefits bieten Sie Ihren Mitarbeitenden heute schon an, und ist Mitarbeiterbindung bei Ihnen gerade ein wichtiges Thema?",
    objectionHandling:
      "Das kann ich gut nachvollziehen. Genau deshalb schauen viele Unternehmen zuerst ganz unverbindlich in 15 Minuten darauf, welche Modelle wirklich sinnvoll sind und was budgetseitig gut darstellbar wäre.",
    close:
      "Wenn Sie mögen, reserviere ich Ihnen direkt einen kurzen Termin mit Herrn Duic – passt Ihnen eher ein Vormittag oder ein Nachmittag besser?",
    consentPrompt: "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?",
    decisionMakerGreeting: "Vielen Dank. Dann steigen wir direkt ein. Soll ich Ihnen kurz sagen, worum es geht?",
    topicExplanation: "Es geht darum, wie Unternehmen mit der betrieblichen Krankenversicherung Mitarbeiterbindung und Arbeitgeberattraktivität spürbar stärken können.",
    preparationConsent: "Um den Termin perfekt vorzubereiten, benötige ich noch zwei kurze Angaben. Ist das für Sie in Ordnung?",
    problemBenefitConfirmation: "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich kurz vor, Herr Duic zeigt Ihnen schwarz auf weiß, wie Sie Mitarbeiterbindung und Gesundheitsleistungen mit einem klaren, kalkulierbaren Modell verbessern können. Wäre das für Sie interessant?",
    appointmentOffer: "Sehr gut. Für den kurzen Austausch mit Herrn Duic kann ich Ihnen zwei Termine anbieten. Welcher passt Ihnen besser?",
    appointmentConfirmation: "Vielen Dank. Dann habe ich den Termin mit Herrn Duic notiert. Die Bestätigung erhalten Sie im Anschluss. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  },
  {
    id: "skript-bav",
    topic: "betriebliche Altersvorsorge",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich melde mich kurz zum Thema betriebliche Altersvorsorge, weil viele Arbeitgeber hier nach verständlichen und attraktiven Lösungen suchen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Wie handhaben Sie die bAV aktuell bei neuen und bestehenden Mitarbeitenden, und gibt es dabei Punkte, die Sie gern einfacher oder attraktiver aufstellen würden?",
    objectionHandling:
      "Verstehe. Häufig reicht schon ein kurzer Blick von außen, um Fördermöglichkeiten, Arbeitgeberaufwand und die Verständlichkeit für Mitarbeitende deutlich besser einzuordnen.",
    close:
      "Gern würde ich Ihnen dafür einen kompakten Termin mit Herrn Duic reservieren – was passt bei Ihnen meist besser, eher Anfang oder eher Ende der Woche?",
    consentPrompt: "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?",
    decisionMakerGreeting: "Vielen Dank. Dann steigen wir direkt ein. Soll ich Ihnen kurz sagen, worum es geht?",
    topicExplanation: "Es geht um die Frage, wie sich die betriebliche Altersvorsorge für Mitarbeitende verständlich und attraktiver aufstellen lässt.",
    preparationConsent: "Um den Termin perfekt vorzubereiten, benötige ich noch zwei kurze Angaben. Ist das für Sie in Ordnung?",
    problemBenefitConfirmation: "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich vor, Herr Duic zeigt Ihnen schwarz auf weiß, wie sich Ihre bAV für Mitarbeitende verständlicher und attraktiver aufstellen lässt. Wäre das für Sie interessant?",
    appointmentOffer: "Sehr gut. Für den kurzen Austausch mit Herrn Duic kann ich Ihnen zwei Termine anbieten. Welcher passt Ihnen besser?",
    appointmentConfirmation: "Vielen Dank. Dann habe ich den Termin mit Herrn Duic notiert. Die Bestätigung erhalten Sie im Anschluss. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  },
  {
    id: "skript-gewerbe",
    topic: "gewerbliche Versicherungen",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an, weil viele Unternehmen ihre gewerblichen Versicherungen momentan neu vergleichen, um Preis und Leistung sauber abzugleichen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Wann haben Sie Ihre gewerblichen Policen zuletzt in Ruhe verglichen – vor allem bei Betriebshaftpflicht, Inhalts- oder Cyberabsicherung?",
    objectionHandling:
      "Das ist absolut verständlich. Ein kurzer Vergleich zeigt oft schon, ob Deckungslücken bestehen oder ob Beiträge günstiger und Leistungen gleichzeitig besser darstellbar wären – ganz ohne direkten Wechselzwang.",
    close:
      "Wenn es für Sie passt, sichere ich Ihnen gern einen unverbindlichen Termin mit Herrn Duic – welcher Tag wäre dafür grundsätzlich angenehm?",
    consentPrompt: "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?",
    decisionMakerGreeting: "Vielen Dank. Dann steigen wir direkt ein. Soll ich Ihnen kurz sagen, worum es geht?",
    topicExplanation: "Es geht um einen kurzen Abgleich, ob Ihre gewerblichen Versicherungen in Preis und Leistung noch sauber zu Ihrem aktuellen Risiko passen.",
    preparationConsent: "Um den Termin perfekt vorzubereiten, benötige ich noch zwei kurze Angaben. Ist das für Sie in Ordnung?",
    problemBenefitConfirmation: "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich vor, Herr Duic zeigt Ihnen schwarz auf weiß, wo bei Ihren Policen Leistung, Preis und mögliche Lücken wirklich stehen. Wäre das für Sie interessant?",
    appointmentOffer: "Sehr gut. Für den kurzen Austausch mit Herrn Duic kann ich Ihnen zwei Termine anbieten. Welcher passt Ihnen besser?",
    appointmentConfirmation: "Vielen Dank. Dann habe ich den Termin mit Herrn Duic notiert. Die Bestätigung erhalten Sie im Anschluss. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  },
  {
    id: "skript-pkv",
    topic: "private Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Wir haben ein Konzept entwickelt, mit dem sich Krankenversicherungsbeiträge im Alter planbarer und stabiler aufstellen lassen. Denn egal ob gesetzlich oder privat versichert: Die Beiträge steigen meist Jahr für Jahr. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Darf ich kurz fragen: Sind Sie derzeit gesetzlich oder privat versichert, und ist das Thema Beitragsstabilität im Alter für Sie grundsätzlich interessant?",
    objectionHandling:
      "Das kann ich gut verstehen. Genau deshalb geht es im Termin nicht um einen schnellen Abschluss, sondern um eine kurze Einordnung, wie sich Beiträge langfristig besser planen lassen. Wenn Sie die Details gerade nicht parat haben, reicht zunächst auch die kurze Info, ob Sie sich derzeit grundsätzlich als gesund bezeichnen würden.",
    close:
      "Wenn es für Sie passt, reserviere ich Ihnen gern einen kurzen Termin mit Herrn Duic. Für die Vorbereitung klären wir dann nur noch ein paar Rahmendaten.",
    consentPrompt: "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?",
    decisionMakerGreeting: "Vielen Dank. Dann steigen wir direkt ein. Soll ich Ihnen kurz sagen, worum es geht?",
    topicExplanation: "Es geht um ein Konzept, mit dem sich Krankenversicherungsbeiträge im Alter deutlich planbarer und stabiler aufstellen lassen.",
    preparationConsent: "Um den Termin perfekt vorzubereiten, benötige ich noch ein paar Gesundheitsangaben. Ist das für Sie in Ordnung?",
    problemBenefitConfirmation: "Verstehe, das geht vielen Unternehmern so. Jetzt stellen Sie sich einmal vor: Sie und Herr Duic sitzen zusammen und Herr Duic zeigt Ihnen schwarz auf weiß, wie sich die Beiträge nach heutigem Stand entwickeln und wie Sie von unserem Konzept profitieren. Wäre das für Sie interessant?",
    appointmentOffer: "Sehr gut. Für den kurzen Austausch mit Herrn Duic kann ich Ihnen zwei Termine anbieten. Welcher passt Ihnen besser?",
    appointmentConfirmation: "Vielen Dank. Dann habe ich den Termin mit Herrn Duic notiert. Die Bestätigung erhalten Sie im Anschluss. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  },
  {
    id: "skript-energie",
    topic: "Energie",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an und melde mich kurz zum Thema gewerbliche Strom- und Gasoptimierung, weil sich dort häufig schnell Einsparpotenziale zeigen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Wie zufrieden sind Sie aktuell mit Ihren gewerblichen Strom- und Gaskonditionen, und steht bei Ihnen in nächster Zeit eine Verlängerung oder Neuverhandlung an?",
    objectionHandling:
      "Verstehe gut. Genau deshalb nutzen viele Unternehmen einen kurzen Vergleich, um ohne großen Aufwand Transparenz über mögliche Einsparungen und bessere Konditionen zu bekommen.",
    close:
      "Wenn Sie möchten, organisiere ich Ihnen direkt einen kurzen Vergleichstermin mit Herrn Duic – wann würde es Ihnen zeitlich am besten passen?",
    consentPrompt: "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?",
    decisionMakerGreeting: "Vielen Dank. Dann steigen wir direkt ein. Soll ich Ihnen kurz sagen, worum es geht?",
    topicExplanation: "Es geht um einen kurzen gewerblichen Strom- und Gasvergleich, um mögliche Einsparpotenziale und bessere Konditionen sichtbar zu machen.",
    preparationConsent: "Um den Termin perfekt vorzubereiten, benötige ich noch zwei kurze Angaben. Ist das für Sie in Ordnung?",
    problemBenefitConfirmation: "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich vor, Herr Duic zeigt Ihnen schwarz auf weiß, welche Einsparungen und Konditionen aktuell für Ihr Unternehmen realistisch sind. Wäre das für Sie interessant?",
    appointmentOffer: "Sehr gut. Für den kurzen Austausch mit Herrn Duic kann ich Ihnen zwei Termine anbieten. Welcher passt Ihnen besser?",
    appointmentConfirmation: "Vielen Dank. Dann habe ich den Termin mit Herrn Duic notiert. Die Bestätigung erhalten Sie im Anschluss. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.",
  },
];

export const defaultLeads: Lead[] = [];

export const defaultReports: CallReport[] = [];
