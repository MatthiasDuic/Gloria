import assert from "node:assert/strict";
import test from "node:test";
import { advanceCallback, extractCallbackTimePhrase, isNoTimeRequest } from "./callback-controller.js";

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
