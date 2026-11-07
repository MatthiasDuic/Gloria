export type ObjectionKind = "no_time" | "existing_advisor" | "send_information" | "skepticism" | "no_need" | "price" | "bad_experience" | "consult_partner" | "statutory_insurance" | "other";

export type ConversationEvent =
  | { type: "opt_out"; text: string; deletion: boolean }
  | { type: "clear_rejection"; text: string }
  | { type: "data_source_question"; text: string }
  | { type: "ai_identity_question"; text: string }
  | { type: "small_talk"; text: string }
  | { type: "customer_question"; text: string }
  | { type: "objection"; text: string; kind: ObjectionKind }
  | { type: "unclear"; text: string }
  | { type: "answer"; text: string };

const LIST_NOUN = String.raw`(?:anruf|kontakt|kunden|adress|telefon)?(?:liste|datenbank|kartei|verteiler|datei)`;

/** Data-deletion requests (GDPR Art. 17) – always also a do-not-call request. */
export function isDataDeletionRequest(text: string): boolean {
  return /\bl[öo]schen\s+sie\b/i.test(text)
    || /\b(?:daten|nummer|telefonnummer|kontaktdaten|angaben|adresse)\b[^.!?]{0,40}\b(?:l[öo]schen|gel[öo]scht|entfernen|entfernt)\b/i.test(text)
    || /\b(?:l[öo]schen|entfernen)\b[^.!?]{0,30}\b(?:meine|unsere|die|alle)\s+(?:daten|nummer|telefonnummer|kontaktdaten|angaben)\b/i.test(text)
    || /\bwiderspreche\b[^.!?]{0,50}\b(?:daten|nutzung|verarbeitung|speicherung|verwendung)\b/i.test(text)
    || /\bwiderspruch\s+gegen\b[^.!?]{0,40}\b(?:daten|nutzung|verarbeitung|speicherung|verwendung)\b/i.test(text);
}

/** Objection to (advertising) calls: Gloria must stop immediately and the number gets suppressed. */
export function isOptOutRequest(text: string): boolean {
  if (isDataDeletionRequest(text)) return true;
  return /\bnicht\s+mehr\s+an(?:rufen|zurufen)\b|\bnie\s+wieder\s+an(?:rufen|zurufen)?\b|\brufen\s+sie\s+(?:mich|uns|hier)?\s*(?:bitte\s+)?(?:nie\s+wieder|nicht\s+mehr|nie\s+mehr)\s+an\b|\bkeine\s+(?:weiteren\s+)?(?:werbe)?anrufe\b|\bkeine\s+werbung\b|\bstreichen\s+sie\s+(?:mich|uns|meine|unsere|die)\b|\bnummer\s+l[öo]schen\b|\bh[öo]ren\s+sie\s+auf,?\s+(?:mich|uns|hier)\s+anzurufen\b|\bwiderspreche\b[^.!?]{0,40}\bwerbung\b/i.test(text)
    || (new RegExp(String.raw`\b(?:aus|von)\s+(?:ihrer|der|eurer|dieser|ihren|den)\s+${LIST_NOUN}`, "i").test(text)
      && /\b(?:nehmen|streichen|l[öo]schen|entfernen|austragen|raus)\b/i.test(text));
}

export function isUnclearConversationText(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-zäöüßı0-9:?!.,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (/^(?:good to|does that|thank you much|i know|anlıyorum|어\?|aso|gute tag|tag|gutes|ich bin ab|hera|fariha|mhm|hmm|hm+|äh+|uh+|oh+|das)[.!?]*$/i.test(normalized)) return true;
  return normalized.length <= 2 && !/^(?:ja|ne|nein|ok|jo|nö)$/i.test(normalized);
}

export function isConversationEndingText(text: string): boolean {
  return isOptOutRequest(text)
    || isTelephoneSalesRefusal(text)
    || /\b(?:kein[e]?\s+interesse|nicht\s+interessiert|rufen\s+sie\s+(?:mich\s+)?(?:bitte\s+)?nicht\s+(?:mehr\s+)?an|nicht\s+mehr\s+anrufen|keine\s+(?:weiteren\s+)?(?:werbe)?anrufe|m[öo]chte\s+(?:kein|keinen)\s+termin|beende\s+(?:das\s+)?gespr[äa]ch|gespr[äa]ch\s+beenden|wir\s+k[öo]nnen\s+das\s+gespr[äa]ch\s+beenden|legen\s+sie\s+auf|auf\s+wiedersehen|auf\s+wiederh[öo]ren|tsch[üu]ss|streichen\s+mich|interessiert\s+mich\s+nicht|kommt\s+nicht\s+infrage)\b/i.test(text);
}

/** "Wir kaufen nichts am Telefon" and similar: a firm refusal of telephone business, not an objection to argue with. */
export function isTelephoneSalesRefusal(text: string): boolean {
  return /\b(?:kaufen|machen|schlie(?:ß|ss)en|unterschreiben|vereinbaren|bestellen)\s+(?:wir|ich)?\s*(?:grunds[äa]tzlich\s+)?(?:nichts|keine\s+gesch[äa]fte|keine\s+vertr[äa]ge|keine\s+termine)\s+(?:\w+\s+)?(?:am|per|übers?|ueber|via)\s+telefon\b|\bkeine\s+(?:gesch[äa]fte|vertr[äa]ge|termine)\s+(?:am|per|übers?|ueber)\s+telefon\b|\bam\s+telefon\s+(?:kaufen|machen|schlie(?:ß|ss)en)\s+(?:wir|ich)\s+(?:grunds[äa]tzlich\s+)?nichts\b/i.test(text);
}

export function isNoNeedStatement(text: string): boolean {
  return /\b(?:kein(?:en)?\s+bedarf|brauchen?\s+(?:wir|ich)\s+(?:das\s+)?(?:nicht|nichts|kein)|brauche\s+(?:ich\s+)?(?:das\s+)?nicht|(?:sind|bin)\s+(?:gut|bestens|ausreichend)\s+(?:versorgt|aufgestellt|abgesichert)|das\s+(?:ist|wäre)\s+(?:für\s+(?:uns|mich)\s+)?(?:kein\s+thema|nichts\s+für\s+(?:uns|mich)))\b/i.test(text);
}

export function isDataSourceQuestion(text: string): boolean {
  return /\bwoher\s+(?:haben|hast|kennen|bekommen|kriegen)\s+(?:sie|du|ihr)\b/i.test(text)
    || /\b(?:woher|wo)\s+(?:haben|hast)\s+(?:sie|du)\s+(?:denn\s+)?(?:meine|unsere|die|diese)\s+(?:nummer|telefonnummer|daten|kontaktdaten|adresse)/i.test(text)
    || /\bwie\s+(?:kommen|sind)\s+sie\s+(?:denn\s+)?(?:auf|an)\s+(?:mich|uns|meine|unsere|diese)\b/i.test(text)
    || /\bwer\s+hat\s+ihnen\s+(?:meine|unsere|diese|die)\s+(?:nummer|telefonnummer|daten|kontaktdaten)\b/i.test(text)
    || /\b(?:nummer|telefonnummer|daten|kontaktdaten)\s+(?:haben\s+sie\s+)?woher\b/i.test(text);
}

export function isAiIdentityQuestion(text: string): boolean {
  return /\b(?:sind|bist)\s+(?:sie|du)\s+(?:denn\s+|eigentlich\s+|etwa\s+|wirklich\s+)?(?:eine?\s+)?(?:ki|k\.\s?i\.|künstliche\s+intelligenz|roboter|bot|computer|maschine|chatbot|sprachcomputer|mensch|echt|real)\b/i.test(text)
    || /\b(?:rede|spreche|telefoniere)\s+ich\s+(?:hier\s+|gerade\s+)?mit\s+(?:ein(?:e[mr]?)?\s+)?(?:ki|künstlichen\s+intelligenz|roboter|bot|computer|maschine|menschen|echten\s+(?:person|menschen))\b/i.test(text)
    || /\bist\s+das\s+(?:hier\s+)?(?:eine?\s+)?(?:ki|roboter|bot|computer|bandansage|maschine)\b/i.test(text);
}

export function isSmallTalk(text: string): boolean {
  return /\bwie\s+geht(?:'?s|\s+es)\s+(?:ihnen|dir|euch)\b|\bwie\s+l[äa]uft(?:'?s|\s+es)\s+(?:bei\s+ihnen|so)\b|\b(?:sch[öo]nes|tolles|mieses|schlechtes|herrliches)\s+wetter\b|\bdas\s+wetter\b|\bregnet\s+(?:es|ja|hier)\b|\b(?:sch[öo]nes|gutes)\s+wochenende\b|\bwo\s+sitzen\s+sie\s+(?:denn\s+)?(?:eigentlich|gerade)?\b|\bfu(?:ß|ss)ball\b|\bbundesliga\b/i.test(text);
}

function isCustomerQuestion(text: string): boolean {
  if (/\?\s*$/.test(text.trim())) return true;
  return /^\s*(?:wer|wie|was|warum|wieso|weshalb|woher|wann|welche[rmn]?|können\s+sie|könnten\s+sie|ist\s+das|geht\s+es|worum)\b/i.test(text);
}

/** "Kennen Sie einen guten Steuerberater?" asks Gloria for a recommendation; it is not an existing-advisor objection. */
function isRecommendationRequest(text: string): boolean {
  return /\b(?:kennen|wissen)\s+sie\b[^.!?]{0,60}\b(?:steuerberater|steuerb[üu]ro|buchhalter|berater|makler|anwalt)/i.test(text)
    || /\bk[öo]nnen\s+sie\b[^.!?]{0,60}\bempfehlen\b/i.test(text);
}

/** Questions about what the appointment costs; answered with the price guide (free, non-binding). */
export function isCostQuestion(text: string): boolean {
  const subject = String.raw`(?:das|der\s+termin|die\s+beratung|das\s+gespr[äa]ch|die\s+analyse|ihre\s+beratung|so\s+ein(?:e)?\s+(?:termin|beratung|gespr[äa]ch|analyse))`;
  return new RegExp(String.raw`\b(?:was|wie\s*viel)\s+kostet\s+(?:mich\s+|uns\s+)?(?:denn\s+)?${subject}\b`, "i").test(text)
    || new RegExp(String.raw`\bkostet\s+(?:mich\s+|uns\s+)?${subject}\s+(?:denn\s+)?(?:etwas|was|geld)\b`, "i").test(text)
    || new RegExp(String.raw`\bist\s+${subject}\s+(?:denn\s+)?(?:kostenlos|kostenfrei|umsonst|gratis|kostenpflichtig)\b`, "i").test(text)
    || /\bmuss\s+ich\s+(?:da(?:f[üu]r)?\s+)?(?:was|etwas)\s+(?:be)?zahlen\b/i.test(text);
}

export type ConversationEventContext = {
  /** Earlier customer utterances of the same call (oldest first, without the current one). */
  previousUserTexts?: readonly string[];
};

export function classifyConversationEvent(text: string, context: ConversationEventContext = {}): ConversationEvent {
  const normalized = text.trim();
  if (isUnclearConversationText(normalized)) return { type: "unclear", text: normalized };
  if (isOptOutRequest(normalized)) return { type: "opt_out", text: normalized, deletion: isDataDeletionRequest(normalized) };
  if (isDataSourceQuestion(normalized)) return { type: "data_source_question", text: normalized };
  if (isConversationEndingText(normalized)) return { type: "clear_rejection", text: normalized };
  if (isNoNeedStatement(normalized)) {
    // First "kein Bedarf" gets one respectful clarification; a repeated one is a clear no.
    const repeated = (context.previousUserTexts || []).some((previous) => isNoNeedStatement(previous));
    return repeated ? { type: "clear_rejection", text: normalized } : { type: "objection", text: normalized, kind: "no_need" };
  }
  if (isAiIdentityQuestion(normalized)) return { type: "ai_identity_question", text: normalized };
  if (/\b(?:ich\s+(?:bin\s+)?(?:gerade\s+)?(?:im\s+auto|am\s+steuer)|ich\s+fahre\s+(?:gerade\s+)?auto)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "no_time" };
  }
  if (/\bmit\s+(?:meiner|meinem|der|dem)\s+(?:frau|mann|partner(?:in)?|geschäftspartner(?:in)?|mitinhaber(?:in)?)\b[^.!?]{0,40}\b(?:besprechen|absprechen|klären|reden)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "consult_partner" };
  }
  if (/\bgesetzlich\s+(?:kranken)?versichert\b/i.test(normalized)
    && /\b(?:betrifft\s+mich\s+nicht|nicht\s+relevant|nicht\s+für\s+mich)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "statutory_insurance" };
  }
  if (isRecommendationRequest(normalized)) return { type: "customer_question", text: normalized };
  if (/\b(?:steuerberater(?:in)?|steuerb[üu]ro|buchhalter(?:in)?|(?:mein|meine|unser|unsere)\s+(?:berater|beraterin|makler|maklerin|vermittler|versicherungsvertreter)\b[^.!?]{0,30}\b(?:k[üu]mmert|macht|regelt)|(?:habe|haben|hab)\s+(?:schon\s+|bereits\s+)?(?:einen|meinen|eine|unsere?n?)\s+(?:berater|beraterin|makler|maklerin|vermittler)|bereits\s+beraten|bin\s+(?:selbst|selber)\s+(?:makler|berater|vermittler|versicherungs\w*))/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "existing_advisor" };
  }
  if (isSmallTalk(normalized)) return { type: "small_talk", text: normalized };
  if (isCostQuestion(normalized)) return { type: "objection", text: normalized, kind: "price" };
  if (isCustomerQuestion(normalized)) return { type: "customer_question", text: normalized };
  if (/\b(?:keine\s+zeit|gerade\s+schlecht|unpassend|bin\s+in\s+einem\s+termin|muss\s+gleich\s+weg|viel\s+zu\s+tun|im\s+stress|gerade\s+besch[äa]ftigt)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "no_time" };
  }
  if (/\b(?:per\s+mail|e-?mail|schicken\s+sie|senden\s+sie|unterlagen\s+zusenden|informationen\s+zusenden)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "send_information" };
  }
  if (/\b(?:zu\s+teuer|kein\s+(?:geld|budget)|nicht\s+leisten|kostet\s+(?:doch\s+)?nur)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "price" };
  }
  if (/\b(?:schlechte\s+erfahrung(?:en)?|reingelegt|über\s+den\s+tisch|versicherungs(?:vertreter|leute|fuzzis?)\b[^.!?]{0,30}\b(?:nerv|schlecht|abzocke))|\babzocke\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "bad_experience" };
  }
  if (/\b(?:glaube\s+ich\s+nicht|klingt(?:\s+für\s+mich)?\s+unrealistisch|bezweifle|sehe\s+den\s+sinn\s+nicht|bringt\s+doch\s+nichts)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "skepticism" };
  }
  return { type: "answer", text: normalized };
}

export function instructionForConversationEvent(
  event: ConversationEvent,
  resumeInstruction?: string,
): string {
  const resume = resumeInstruction?.trim();
  switch (event.type) {
    case "opt_out":
      return "Der Kunde widerspricht weiteren Anrufen. Bestätige sofort in einem Satz, dass er nicht mehr angerufen wird, entschuldige dich kurz für die Störung, verabschiede dich hörbar auf Deutsch und rufe danach end_call auf. Kein Überzeugungsversuch, keine Frage.";
    case "clear_rejection":
      return "Akzeptiere die klare Ablehnung sofort und ohne Überredungsversuch. Verabschiede dich kurz und hörbar auf Deutsch und rufe danach end_call auf. Stelle keine weitere Frage.";
    case "data_source_question":
      return [
        "Der Kunde fragt, woher die Kontaktdaten stammen. Beantworte das ehrlich und konkret mit der Angabe aus der Regel DATENHERKUNFT, ohne etwas zu erfinden.",
        "Biete an, ihn auf Wunsch aus der Liste zu nehmen.",
        resume ? `Wenn er das Gespräch fortsetzt, beachte als nächsten fachlichen Schritt: ${resume}` : "Frage danach kurz, ob du dein Anliegen in einem Satz erklären darfst.",
      ].join(" ");
    case "ai_identity_question":
      return [
        "Der Kunde fragt, ob er mit einer KI spricht. Bestätige ehrlich und ohne Ausflüchte in einem Satz, dass du eine KI-Assistentin bist, die im Auftrag des Beraters anruft, und dass der Termin selbst mit dem Berater persönlich stattfindet.",
        resume ? `Kehre danach ohne Rechtfertigung zum Gespräch zurück und beachte als nächsten fachlichen Schritt: ${resume}` : "Frage danach kurz, ob du dein Anliegen in einem Satz erklären darfst.",
      ].join(" ");
    case "small_talk":
      return [
        `Der Kunde macht Smalltalk: "${event.text}". Reagiere freundlich, menschlich und in höchstens einem kurzen Satz darauf (z. B. kurz zustimmen oder die Frage knapp und ehrlich beantworten). Erfinde keine eigenen Erlebnisse, Orte oder Wetterbeobachtungen.`,
        resume ? `Leite danach mit einer natürlichen Brücke zurück zum Anliegen und beachte als nächsten fachlichen Schritt: ${resume}` : "Leite danach mit einer natürlichen Brücke zum Anliegen zurück und stelle genau eine passende Frage.",
      ].join(" ");
    case "customer_question":
      return [
        `Beantworte zuerst ausschließlich die konkrete Kundenfrage: "${event.text}". Antworte ehrlich, knapp und ohne erfundene Fakten.`,
        resume ? `Kehre danach nur dann natürlich zurück und beachte als nächsten fachlichen Schritt: ${resume}` : "Stelle danach höchstens eine passende kurze Frage.",
      ].join(" ");
    case "objection":
      return [
        `Reagiere zuerst auf den Einwand "${event.text}". Bestätige die Perspektive knapp, antworte konkret und übe keinen Druck aus.`,
        objectionReplyGuide(event.kind),
        resume ? `Wenn der Kunde offen bleibt, beachte anschließend als nächsten fachlichen Schritt: ${resume}` : "Stelle danach höchstens eine passende kurze Frage.",
      ].join(" ");
    case "unclear":
      return "Die letzte Äußerung war akustisch oder inhaltlich unklar. Leite daraus keine Zustimmung, Ablehnung, Terminwahl oder neue Tatsache ab. Frage genau einmal kurz auf Deutsch nach, wie der Kunde es gemeint hat.";
    case "answer":
      return resume || "Antworte direkt und situativ auf die letzte Kundenaussage. Stelle höchstens eine passende kurze Frage.";
  }
}

function objectionReplyGuide(kind: ObjectionKind): string {
  switch (kind) {
    case "no_time":
      return "Führe keinen Pitch, keine Qualifizierung und keine Terminierung fort. Wenn der Kunde Auto fährt, halte ihn nicht im Gespräch. Frage höchstens nach einem passenden Rückrufzeitpunkt und akzeptiere auch, wenn er keinen nennen möchte.";
    case "existing_advisor":
      return "Würdige die bestehende Betreuung ausdrücklich, ohne jemanden abzuwerten. Nennt der Kunde einen Steuerberater oder Buchhalter: Erkläre in einem Satz, dass dieser die steuerliche Seite abdeckt, während es im Termin um das konkrete Thema des Auftrags geht, und dass er gern einbezogen werden kann. Nennt er einen Berater oder Makler: Stelle den Termin als unverbindlichen Zweitblick dar. Ist der Kunde selbst Makler oder Vermittler, nimm das ernst und frage, ob ein fachlicher Austausch auf Augenhöhe für ihn interessant ist.";
    case "send_information":
      return "Sage in einem Satz freundlich, dass allgemeine Unterlagen die eigene Situation kaum abbilden und genau diese Einordnung im kurzen Termin passiert. Stelle danach genau eine Frage: ob ein kurzer, unverbindlicher Termin dafür in Ordnung wäre. Biete keinen Unterlagenversand an und frage nicht nach einer E-Mail-Adresse.";
    case "skepticism":
      return "Nimm den Zweifel ernst. Erkläre knapp, dass im Termin die eigene Ausgangslage mit nachvollziehbaren Annahmen geprüft wird, nicht mit Versprechen.";
    case "no_need":
      return "Akzeptiere die Aussage respektvoll und dränge nicht. Stelle genau eine kurze, offene Rückfrage, die zeigt, ob das Thema wirklich geklärt ist (z. B. ob die künftige Beitragsentwicklung bereits eingeplant ist). Wenn der Kunde erneut ablehnt, verabschiede dich freundlich.";
    case "price":
      return "Erkläre die Unverbindlichkeit des Termins. Bezeichne ihn nur als kostenfrei, wenn der Auftrag oder das hinterlegte Wissen dies ausdrücklich bestätigt; sonst sage, dass der Berater die Kostenfrage klären muss. Erfinde keine Honorare oder Gebühren und mache keine Ersparnisversprechen. Stelle danach höchstens eine kurze Frage.";
    case "consult_partner":
      return "Respektiere, dass der Kunde erst Rücksprache halten möchte. Biete an, die genannte Person in einen möglichen Termin einzubeziehen, ohne schon einen Termin zu buchen. Frage höchstens, ob ein späterer Rückruf nach der Rücksprache sinnvoll ist.";
    case "statutory_insurance":
      return "Nimm den Hinweis auf die gesetzliche Versicherung ernst. Erläutere nur dann kurz einen Bezug zum Thema, wenn der Auftrag ihn tatsächlich abdeckt. Behaupte keine PKV-Wechselmöglichkeit, keine Einsparung und keine individuelle Eignung. Passt der Auftrag nicht, beende das Gespräch höflich.";
    case "bad_experience":
      return "Zeige echtes Verständnis für die schlechte Erfahrung, ohne die Branche zu verteidigen oder andere abzuwerten. Betone Transparenz und Unverbindlichkeit und frage, ob ein kurzer, offener Termin trotzdem in Ordnung wäre.";
    default:
      return "Widerlege den Kunden nicht pauschal. Bleibe bei einer kurzen, konkreten Antwort und höchstens einer passenden Frage.";
  }
}