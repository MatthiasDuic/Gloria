import type { ScriptConfig } from "@/lib/types";

export interface ScriptFlowSchema {
  reception: {
    intro: string;
    reasonIfAsked: string;
  };
  decider: {
    intro: string;
    problemIntro: string;
    problemDeepening: string;
    needsAssessment: string;
    conceptVisualization: string;
    benefitSummary: string;
    transitionToDataCollection: string;
    transitionToAppointment: string;
  };
  objections: {
    noTime: string;
    noInterest: string;
    sendInfo: string;
    later: string;
  };
  appointment: {
    offer: string;
    confirm: string;
    wrapUp: string;
  };
}

export function buildDefaultScriptFlow(script: ScriptConfig): ScriptFlowSchema {
  return {
    reception: {
      intro: script.opener,
      reasonIfAsked: script.gatekeeperBehavior || "Ich rufe an, weil wir Unternehmen bei der Terminvorbereitung unterstützen.",
    },
    decider: {
      intro: script.opener,
      problemIntro: script.discovery,
      problemDeepening: script.objectionHandling,
      needsAssessment: script.discovery,
      conceptVisualization: script.aiKeyInfo || script.discovery,
      benefitSummary: script.appointmentGoal || script.close,
      transitionToDataCollection: script.pkvHealthIntro || "Wenn es für Sie passt, erfasse ich kurz die relevanten Eckdaten.",
      transitionToAppointment: script.close,
    },
    objections: {
      noTime: script.objectionHandling,
      noInterest: script.objectionHandling,
      sendInfo: "Sehr gern, ich sende Ihnen eine kurze Zusammenfassung. Zusätzlich empfehle ich einen kurzen Termin für Rückfragen.",
      later: "Kein Problem. Dann vereinbaren wir einen konkreten Rückrufzeitpunkt.",
    },
    appointment: {
      offer: script.close,
      confirm: "Perfekt, dann bestätige ich den Termin verbindlich.",
      wrapUp: "Vielen Dank für das Gespräch. Auf Wiederhören.",
    },
  };
}
