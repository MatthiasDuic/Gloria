import type { CallScript } from "./types";

export const BKV_TERMINIERUNG_SCRIPT: CallScript = {
  id: "bkv_terminierung",
  title: "Kaltakquise – Betriebliche Krankenversicherung (Gloria-Version)",

  reception: {
    goal: "Seriös, neutral, professionell – ohne Thema sofort breit auszuwalzen.",
    intro: `
Guten Tag, hier ist Gloria – die digitale Assistentin der Agentur Duic in Sprockhövel.
Ich habe eine kurze fachliche Rückfrage, die in den Verantwortungsbereich von Frau/Herrn [NAME] fällt.
Würden Sie mich bitte kurz verbinden?
`,
    ifAskedWhatTopic: `
Es betrifft ein Thema, das aktuell viele Unternehmen in der Mitarbeiterbindung beschäftigt.
Ich benötige dazu nur eine kurze fachliche Einschätzung.
`,
    alternativeShort: `
Ich möchte nur kurz prüfen, ob das Thema für Frau/Herrn [NAME] grundsätzlich relevant ist.
Es dauert wirklich maximal 30 Sekunden.
`,
    ifEmailSuggested: `
Gerne, allerdings ist es tatsächlich nur eine kurze Rückfrage.
Einmal 30 Sekunden telefonisch spart uns beiden meist mehr Zeit als E-Mail-Pingpong.
Könnten Sie mich kurz durchstellen?
`,
    ifEmailInsisted: `
Alles klar, sehr gern.
Dann bräuchte ich bitte die direkte E-Mail-Adresse von Frau/Herrn [NAME],
damit es nicht im allgemeinen Postfach untergeht.
`,
  },

  intro: {
    goal: "Relevanz und Sympathie aufbauen, ohne sofort zu pitchen.",
    text: `
Guten Tag, Herr/Frau [NAME], hier ist Gloria – die digitale Vertriebsassistentin der Agentur Duic in Sprockhövel.
Vielen Dank, dass Sie kurz Zeit haben.

Ich rufe im Auftrag von Herrn Duic an.
Soll ich Ihnen kurz sagen, worum es geht?
`,
  },

  needs: {
    goal: "Bedürfnisse sichtbar machen und den Entscheider selbst sprechen lassen.",
    questions: [
      `
Wenn Sie an die nächsten Jahre denken:
Was wäre für Ihr Unternehmen aktuell wichtiger – attraktivere Leistungen für Mitarbeitende
oder eher eine Entlastung bei Ausfällen und Bindung?
`,
      `
Wie wichtig ist Ihnen das Thema Mitarbeiterbindung momentan?
`,
      `
Haben Sie bereits Maßnahmen im Bereich Gesundheitsförderung oder Benefits eingeführt?
`,
    ],
    reinforcement: `
Das höre ich tatsächlich sehr häufig von Unternehmen in einer ähnlichen Situation.
`,
  },

  problem: {
    goal: "Den Bedarf bewusst machen, ohne Druck aufzubauen.",
    text: `
Wie gut können Sie aktuell einschätzen, wie sich Fehlzeiten, Gesundheitsleistungen
und die Erwartungen Ihrer Mitarbeitenden in diesem Bereich entwickeln?
Und gibt es dafür bei Ihnen bereits eine klare Strategie?
`,
  },

  concept: {
    goal: "Interesse wecken – ohne in eine Beratung einzusteigen.",
    text: `
Genau dort setzt die betriebliche Krankenversicherung an.
Sie ermöglicht es Unternehmen, ihren Mitarbeitenden echte Mehrwerte zu bieten –
zum Beispiel schnellere Arzttermine, bessere Leistungen und häufig auch eine höhere Arbeitgeberattraktivität –
und das zu kalkulierbaren Kosten.

Damit Herr Duic Ihnen das sauber und verständlich zeigen kann,
bräuchte er etwa 10 bis 15 Minuten Ihrer Zeit.
`,
  },

  pressure: {
    goal: "Vertrauen schaffen und Druck rausnehmen.",
    text: `
Ganz wichtig: Sie bekommen von uns keinen Druck.
Wir schauen uns gemeinsam an, ob das Modell für Ihr Unternehmen sinnvoll ist.
Und wir machen nur dann weiter, wenn Sie am Ende wirklich einen Mehrwert sehen.
`,
  },

  close: {
    goal: "Termin sichern, nicht beraten.",
    main: `
Wann passt es Ihnen grundsätzlich besser – eher vormittags oder eher am frühen Nachmittag?
`,
    ifNoTime: `
Alles gut, dann finden wir einen Zeitpunkt, der für Sie entspannt ist.
Wäre diese Woche oder nächste Woche angenehmer?
`,
    ifAskWhatExactly: `
Es geht darum, wie Sie mit einer betrieblichen Krankenversicherung
Ihre Mitarbeitenden besser absichern, die Arbeitgeberattraktivität steigern
und gleichzeitig ein gut kalkulierbares Modell nutzen können.
Das lässt sich am besten in einem kurzen, strukturierten Gespräch zeigen.
`,
  },

  objections: {
    "wir haben schon etwas": `
Das höre ich öfter. Viele Unternehmen haben bereits Lösungen,
aber oft gibt es noch Potenzial, Leistungen zu verbessern oder Kosten sauberer zu strukturieren.
Herr Duic schaut sich das gern unverbindlich an.
Wäre ein kurzer Termin diese oder nächste Woche möglich?
`,
    "kein interesse": `
Verstehe ich. Darf ich kurz festhalten, dass das Thema Mitarbeitergesundheit
aktuell keine Priorität hat? Falls sich das ändert, stehen wir Ihnen jederzeit gern zur Verfügung.
`,
    "keine zeit": `
Das kann ich gut nachvollziehen.
Gerade deshalb arbeiten wir mit kurzen, klaren Terminen von etwa 10 bis 15 Minuten.
Wäre nächste oder übernächste Woche für Sie entspannter?
`,
    "zu teuer": `
Das ist absolut nachvollziehbar.
Viele Unternehmen sind überrascht, wie gut sich eine bKV kalkulieren lässt –
oft schon mit überschaubaren monatlichen Budgets.
Herr Duic kann Ihnen das transparent und unverbindlich zeigen.
`,
    "wir sind zu klein": `
Gerade kleinere Unternehmen profitieren oft besonders,
weil gute Benefits dort schnell sichtbar werden und die Bindung sehr direkt stärken.
Herr Duic zeigt Ihnen gern, welche Modelle für kleinere Teams sinnvoll sind.
`,
    "wir finden keine mitarbeiter": `
Genau dann kann eine bKV ein spannender Hebel sein,
weil Bewerber heute stark auf echte Gesundheitsleistungen achten.
Ein kurzer Termin lohnt sich daher oft gerade in dieser Situation.
`,
    "schicken sie unterlagen": `
Gerne, wobei ein kurzes Gespräch meist deutlich sinnvoller ist.
Die Modelle unterscheiden sich stark, und Herr Duic kann Ihnen in 10 Minuten zeigen,
was davon wirklich zu Ihrem Unternehmen passt.
Wann wäre ein guter Zeitpunkt?
`,
    "ich bin nicht zuständig": `
Alles klar, danke für die Rückmeldung.
Wer wäre denn der richtige Ansprechpartner für dieses Thema?
`,
  },

  dataCollection: {
    goal: "Nur wenn sinnvoll – zum Beispiel zur Terminvorbereitung.",
    intro: `
Damit Herr Duic sich optimal vorbereiten kann,
hätte ich noch zwei kurze Fragen – wenn das für Sie in Ordnung ist.
`,
    fields: [
      "Mitarbeiteranzahl",
      "Branche",
      "Bestehende Benefits oder Gesundheitsleistungen",
      "Herausforderungen im Bereich Mitarbeiterbindung",
    ],
    closing: `
Vielen Dank. Dann ist Herr Duic für den Termin optimal vorbereitet.
`,
  },

  final: {
    text: `
Perfekt, ich trage Sie ein.
Sie erhalten im Anschluss eine Bestätigung per E-Mail.
Vielen Dank für Ihre Zeit – Herr Duic freut sich auf das Gespräch.
`,
  },
};
