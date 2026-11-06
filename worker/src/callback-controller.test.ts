import assert from "node:assert/strict";
import test from "node:test";
import { advanceCallback, classifyCallbackDirection, classifyCallbackNumberReply, extractCallbackTimePhrase, formatCallbackPhoneForSpeech, isCallbackNumberRequest, isNoTimeRequest, needsTimeToWriteCallbackNumber } from "./callback-controller.js";

test("recognizes requests to leave the caller's number without confusing them with the recipient's number", () => {
  for (const text of [
    "Nein, Herr Lichtenberg ist gerade nicht da, aber wenn Sie mir eine Nummer hinterlassen, die ich mir aufschreiben kann, dann wird er Sie gleich zurückrufen, sobald er wieder da ist.",
    "Wie lautet Ihre Telefonnummer?",
    "Unter welcher Nummer kann er Sie erreichen?",
    "Geben Sie mir bitte Ihre Rückrufnummer.",
    "Ich kann Ihre Nummer gerne an ihn weitergeben.",
    "Welche Nummer soll ich ihm für den Rückruf notieren?",
  ]) {
    assert.equal(isCallbackNumberRequest(text), true, text);
  }
  for (const text of [
    "Darf ich Ihnen meine Telefonnummer geben?",
    "Ich kann Ihnen eine Nummer hinterlassen.",
    "Ich gebe Ihnen die Nummer von Herrn Lichtenberg.",
    "Ich habe eine neue Rufnummer.",
    "Bitte hinterlassen Sie keine Nummer.",
    "Ich verbinde Sie mit der Nummer eins.",
  ]) {
    assert.equal(isCallbackNumberRequest(text), false, text);
  }
});

test("distinguishes an incoming callback offer from a request for Gloria to call again", () => {
  for (const text of [
    "Dann wird er Sie gleich zurückrufen.",
    "Er ruft Sie in zehn Minuten zurück.",
    "Herr Lichtenberg wird Sie zurückrufen.",
    "Ich rufe Sie zurück.",
    "Wir rufen Sie zurück.",
  ]) assert.equal(classifyCallbackDirection(text), "incoming", text);
  for (const text of [
    "Rufen Sie mich stattdessen morgen zurück.",
    "Könnten Sie mich in zehn Minuten zurückrufen?",
    "Sie können mich morgen anrufen.",
  ]) assert.equal(classifyCallbackDirection(text), "outgoing", text);
  assert.equal(classifyCallbackDirection("Wann haben Sie Zeit?"), undefined);
});

test("waits for the listener to be ready and distinguishes repetition from confirmation", () => {
  assert.equal(needsTimeToWriteCallbackNumber("Einen Moment, ich muss einen Stift holen."), true);
  assert.equal(needsTimeToWriteCallbackNumber("Ich kann die Nummer aufschreiben."), false);
  assert.equal(classifyCallbackNumberReply("Ja, ich bin bereit.", "waiting_for_ready"), "repeat");
  assert.equal(classifyCallbackNumberReply("Nein, bitte noch einmal.", "waiting_for_confirmation"), "repeat");
  assert.equal(classifyCallbackNumberReply("Ja, danke, ich gebe es weiter.", "waiting_for_confirmation"), "finish");
  assert.equal(classifyCallbackNumberReply("Ja.", "waiting_for_repeat_confirmation"), "repeat");
  assert.equal(classifyCallbackNumberReply("Nein.", "waiting_for_repeat_confirmation"), "finish");
});

test("speaks a validated callback number digit by digit", () => {
  assert.equal(formatCallbackPhoneForSpeech("+491701234567"), "plus vier neun, eins sieben null, eins zwei drei, vier fünf sechs, sieben");
  assert.equal(formatCallbackPhoneForSpeech(""), undefined);
  assert.equal(formatCallbackPhoneForSpeech("sip:test@example.test"), undefined);
  assert.equal(formatCallbackPhoneForSpeech("+123"), undefined);
});

test("recognizes typical 'no time right now' answers", () => {
  for (const text of ["In gerade ist es schlecht.", "Ich habe gerade keine Zeit.", "Passt gerade nicht.", "Ich bin gerade in einem Termin.", "Rufen Sie mich morgen nochmal an.", "Im Moment ist es ungünstig."]) {
    assert.equal(isNoTimeRequest(text, "Passt es gerade für ein kurzes Gespräch?"), true, text);
  }
  for (const text of ["Das weiß ich jetzt nicht.", "Ja, passt.", "Die Beiträge sind schlecht kalkuliert."]) {
    assert.equal(isNoTimeRequest(text, "Wie erleben Sie das?"), false, text);
  }
  assert.equal(isNoTimeRequest("Am Montag habe ich keine Zeit.", "Passt Ihnen Montag um 10 Uhr oder Mittwoch um 14 Uhr?"), false);
});

test("extracts the agreed callback time in speakable form", () => {
  assert.equal(extractCallbackTimePhrase("Sie können gerne morgen Vormittag anrufen."), "morgen Vormittag");
  assert.equal(extractCallbackTimePhrase("Gegen 11 Uhr ist gut."), "gegen 11 Uhr");
  assert.equal(extractCallbackTimePhrase("Morgen gegen 11 Uhr."), "morgen gegen 11 Uhr");
  assert.equal(extractCallbackTimePhrase("Dienstag passt."), "am Dienstag");
  assert.equal(extractCallbackTimePhrase("In zehn Minuten."), "in zehn Minuten");
  assert.equal(extractCallbackTimePhrase("Nächste Woche."), "nächste Woche");
  assert.equal(extractCallbackTimePhrase("Heute ist es schlecht."), undefined);
  assert.equal(extractCallbackTimePhrase("Morgen geht nicht, aber Freitag."), "am Freitag");
  assert.equal(extractCallbackTimePhrase("Ich muss gleich weg."), undefined);
});

test("the callback flow asks once for a time, takes it over and says goodbye", () => {
  const first = advanceCallback("inactive", "In gerade ist es schlecht.");
  assert.equal(first.stage, "asking_time");
  assert.equal(first.hangup, false);
  assert.match(first.speech, /Wann passt es Ihnen besser\?/);

  const second = advanceCallback(first.stage, "Sie können gerne morgen Vormittag anrufen.");
  assert.equal(second.stage, "done");
  assert.equal(second.hangup, true);
  assert.equal(second.speech, "Vielen Dank für das Gespräch. Dann melde ich mich wie besprochen morgen Vormittag noch einmal bei Ihnen. Einen schönen Tag noch und auf Wiederhören.");
  assert.doesNotMatch(second.speech, /Passt das|\?/);
});

test("a time given together with the 'no time' answer ends the call immediately", () => {
  const step = advanceCallback("inactive", "Gerade schlecht, rufen Sie mich morgen gegen 10 Uhr an.");
  assert.equal(step.hangup, true);
  assert.match(step.speech, /wie besprochen morgen gegen 10 Uhr/);
});

test("without a concrete time Gloria asks once more and then says goodbye anyway", () => {
  const first = advanceCallback("inactive", "Ich habe gerade keine Zeit, rufen Sie später an.");
  assert.equal(first.stage, "asking_time");
  const again = advanceCallback(first.stage, "Weiß ich noch nicht.");
  assert.equal(again.stage, "asked_again");
  assert.equal(again.hangup, false);
  const last = advanceCallback(again.stage, "Keine Ahnung.");
  assert.equal(last.hangup, true);
  assert.match(last.speech, /zu einem späteren Zeitpunkt/);
});
