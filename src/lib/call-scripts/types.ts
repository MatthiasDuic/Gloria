export interface CallScript {
  id: string;
  title: string;
  reception: {
    goal: string;
    intro: string;
    ifAskedWhatTopic?: string;
    alternativeShort?: string;
    ifEmailSuggested?: string;
    ifEmailInsisted?: string;
  };
  intro: {
    goal: string;
    text: string;
  };
  needs: {
    goal: string;
    questions: string[];
    reinforcement?: string;
  };
  problem: {
    goal: string;
    text: string;
  };
  concept: {
    goal: string;
    text: string;
  };
  pressure: {
    goal: string;
    text: string;
  };
  close: {
    goal: string;
    main: string;
    ifNoTime?: string;
    ifAskWhatExactly?: string;
  };
  objections: Record<string, string>;
  dataCollection: {
    goal: string;
    intro: string;
    fields: string[];
    ifDetailsDeclined?: string;
    closing: string;
  };
  final: {
    text: string;
  };
}
