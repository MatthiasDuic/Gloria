import type { CallScript } from "./types";

export const PKV_TERMINIERUNG_SCRIPT: CallScript = {
  id: "pkv_terminierung",
  title: "Kaltakquise – PKV / Beitragsstabilität & Planbarkeit im Alter (Gloria-Version)",

  reception: {
    goal: "Sachlich und zielgerichtet verbinden lassen.",
    intro: `
Guten Tag, hier ist Gloria – die digitale Assistentin der Agentur Duic in Sprockhövel.
Ich habe eine kurze fachliche Rückfrage für Frau/Herrn [NAME].
Könnten Sie mich bitte kurz verbinden?
`,
    ifAskedWhatTopic: `
Es geht um ein Thema, das langfristig fast jeden betrifft – nämlich steigende Krankenversicherungsbeiträge.
Ich brauche dazu nur eine kurze Einschätzung.
`,
    alternativeShort: `
Ich möchte nur kurz prüfen, ob das Thema für Frau/Herrn [NAME] aktuell relevant ist.
`,
    ifEmailSuggested: `
Gerne, allerdings lässt sich das telefonisch in wenigen Sekunden meist besser einordnen.
`,
    ifEmailInsisted: `
Alles klar, dann notiere ich gern die direkte E-Mail-Adresse.
`,
  },

  intro: {
    goal: "Relevanz über Beitragsstabilität und Planbarkeit im Alter schaffen.",
    text: `
Guten Tag, Herr/Frau [NAME], hier ist Gloria – die digitale Vertriebsassistentin der Agentur Duic in Sprockhövel.
Vielen Dank, dass Sie kurz Zeit haben.

Ich rufe im Auftrag von Herrn Duic an. Wir haben ein Konzept entwickelt,
mit dem sich Krankenversicherungsbeiträge im Alter deutlich planbarer und stabiler aufstellen lassen.
Denn ganz unabhängig davon, ob jemand gesetzlich oder privat versichert ist,
haben im Grunde alle dasselbe Problem: Die Beiträge steigen von Jahr zu Jahr.
Solange man im Berufsleben steht, lässt sich das oft noch gut tragen –
im wohlverdienten Ruhestand sieht das für viele Menschen jedoch ganz anders aus.

Darf ich kurz fragen: Ist das Thema Beitragsstabilität und Planbarkeit im Alter für Sie grundsätzlich interessant?
`,
  },

  needs: {
    goal: "Ausgangslage und Interesse am Konzept feststellen.",
    questions: [
      `
Sind Sie derzeit gesetzlich oder privat krankenversichert?
`,
      `
Ist für Sie eher die aktuelle Beitragshöhe wichtig – oder vor allem die Frage,
wie planbar und bezahlbar das Ganze im Ruhestand bleibt?
`,
      `
Haben Sie sich mit dem Thema steigende Krankenversicherungsbeiträge im Alter bereits intensiver beschäftigt?
`,
    ],
    reinforcement: `
Genau das ist ein Punkt, den derzeit sehr viele Menschen noch nicht sauber auf dem Schirm haben.
`,
  },

  problem: {
    goal: "Das Problem bewusst und persönlich greifbar machen.",
    text: `
Viele Menschen wissen heute gar nicht genau,
wie sich ihre Beiträge in zehn, fünfzehn oder zwanzig Jahren entwickeln werden.
Und genau diese fehlende Planbarkeit wird später oft zum Problem.
Wie klar haben Sie dieses Thema für sich aktuell aufgestellt?
`,
  },

  concept: {
    goal: "Das Konzept von Herrn Duic als relevanten Mehrwert positionieren.",
    text: `
Genau hier setzt das Konzept von Herrn Duic an.
Er zeigt in einem kurzen, verständlichen Gespräch,
welche Möglichkeiten es gibt, Beiträge langfristig stabiler, planbarer und im Alter besser tragbar zu machen.
Das gilt sowohl für Menschen in der GKV als auch in der PKV.
`,
  },

  pressure: {
    goal: "Druck vermeiden und Vertrauen schaffen.",
    text: `
Ganz wichtig: Es geht dabei nicht um einen schnellen Abschluss.
Es geht zuerst nur darum, Ihre Situation sauber einzuordnen und zu prüfen,
ob das Konzept für Sie überhaupt sinnvoll ist.
`,
  },

  close: {
    goal: "Ersttermin sichern und die Vorqualifikation ankündigen.",
    main: `
Wenn das für Sie interessant klingt, vereinbare ich Ihnen gern einen kurzen Termin mit Herrn Duic.
Wann wäre es für Sie grundsätzlich angenehmer – eher vormittags oder eher nachmittags?
`,
    ifNoTime: `
Alles gut. Dann planen wir gern einen ruhigen Termin in den nächsten Tagen oder in der kommenden Woche.
`,
    ifAskWhatExactly: `
Es geht darum, wie sich Ihre Krankenversicherungsbeiträge langfristig stabiler und planbarer aufstellen lassen,
damit das Thema auch im Ruhestand gut tragbar bleibt.
`,
  },

  objections: {
    "ich bin zufrieden": `
Das ist absolut in Ordnung.
Gerade dann lohnt sich oft eine kurze Bestätigung, ob die heutige Situation auch langfristig – gerade fürs Alter – wirklich stabil aufgestellt ist.
`,
    "kein interesse": `
Verstanden.
Dann halte ich fest, dass das Thema Beitragsstabilität im Moment keine Priorität hat.
`,
    "keine zeit": `
Kann ich gut nachvollziehen.
Gerade deshalb ist der Termin bewusst kurz gehalten und auf 10 bis 15 Minuten begrenzt.
`,
    "zu teuer": `
Genau deshalb ist das Thema so spannend.
Es geht nicht darum, heute mehr zu zahlen, sondern langfristig bessere Planbarkeit und mehr Beitragskontrolle zu schaffen.
`,
    "ich bin gesetzlich versichert": `
Genau deshalb kann das interessant sein.
Auch in der gesetzlichen Krankenversicherung steigen die Beiträge über die Jahre,
und im Ruhestand wird das Thema für viele noch relevanter.
`,
    "ich will keine daten angeben": `
Das ist völlig in Ordnung.
Wir können den Termin trotzdem vereinbaren.
Wenn Sie die Details gerade nicht nennen möchten, reicht mir als kurze Einschätzung: Würden Sie sagen, dass Sie derzeit grundsätzlich gesund sind?
`,
    "ich bin nicht zuständig": `
Alles klar – danke.
Wer ist hierfür bei Ihnen der passende Ansprechpartner?
`,
  },

  dataCollection: {
    goal: "Vorqualifikation für den Termin und die Einschätzung des Konzepts.",
    intro: `
Damit Herr Duic den Termin sauber vorbereiten und direkt sinnvoll einschätzen kann,
hätte ich vorab noch ein paar kurze Fragen – natürlich nur soweit Sie das gerade beantworten möchten.
`,
    fields: [
      "Geburtsdatum",
      "Derzeitiger Versicherungsstatus (GKV / PKV)",
      "Aktueller Versicherer",
      "Versichert seit",
      "Aktueller Beitrag",
      "Selbstbeteiligung",
      "Familienstand",
      "Größe und Gewicht",
      "Regelmäßige Medikamente",
      "Bestehende Erkrankungen",
      "Psychische Behandlungen in den letzten 10 Jahren",
      "Krankenhausaufenthalte in den letzten 10 Jahren",
      "Fehlende Zähne",
      "Allergien",
    ],
    ifDetailsDeclined: `
Wenn Sie diese Punkte gerade nicht im Detail beantworten möchten, ist das vollkommen in Ordnung.
Dann reicht mir als kurze Einschätzung zunächst die Antwort auf eine Frage:
Würden Sie sagen, dass Sie derzeit grundsätzlich gesund sind?
Wenn ja, ist das für die Terminvereinbarung völlig ausreichend.
`,
    closing: `
Vielen Dank. Damit kann Herr Duic den Termin gezielt vorbereiten und direkt auf Ihre Situation eingehen.
`,
  },

  final: {
    text: `
Perfekt, ich habe den Termin notiert.
Sie erhalten gleich eine Bestätigung.
Vielen Dank für Ihre Zeit.
`,
  },
};
