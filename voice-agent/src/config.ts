// Assistant configuration. Field names and defaults follow the turn-taking
// model documented in ../re-workspace/notes/ARCHITECTURE.md.

export interface StartSpeakingPlan {
  /** Silence to wait after a final transcript ending in . ! or ? */
  onPunctuationSeconds: number;
  /** Silence to wait when the final transcript has no ending punctuation. */
  onNoPunctuationSeconds: number;
  /** Silence to wait when the transcript ends in a number (e.g. reading digits). */
  onNumberSeconds: number;
  /** Extra delay before the assistant's first audio of a turn. */
  waitSeconds: number;
}

export interface StopSpeakingPlan {
  /**
   * Words the user must say over the assistant to interrupt it. 0 means any
   * detected voice activity interrupts immediately.
   */
  numWords: number;
  /** After an interruption, don't start a new reply for this long. */
  backoffSeconds: number;
  /** Short affirmations that never count as an interruption. */
  acknowledgementPhrases: string[];
  /** Phrases that always interrupt immediately. */
  interruptionPhrases: string[];
}

export interface AssistantConfig {
  systemPrompt: string;
  /** Spoken as soon as the call connects. Empty string = wait for the user. */
  firstMessage: string;
  sampleRate: number;
  /** Hang up after this long. */
  maxDurationSeconds: number;
  startSpeakingPlan: StartSpeakingPlan;
  stopSpeakingPlan: StopSpeakingPlan;
}

export const defaultConfig: AssistantConfig = {
  systemPrompt: [
    "You are a friendly, concise voice assistant on a live call.",
    "Latency-sensitive; begin your visible answer immediately.",
    "Your replies are spoken aloud: use short conversational sentences,",
    "no markdown, lists, emoji or URLs. Ask one question at a time.",
    "If the caller wants to end the call, say goodbye and use the end_call tool.",
  ].join(" "),
  firstMessage: "Hi! How can I help you today?",
  sampleRate: 16000,
  maxDurationSeconds: 600,
  startSpeakingPlan: {
    onPunctuationSeconds: 0.1,
    onNoPunctuationSeconds: 1.5,
    onNumberSeconds: 0.5,
    waitSeconds: 0,
  },
  stopSpeakingPlan: {
    numWords: 2,
    backoffSeconds: 1,
    acknowledgementPhrases: [
      "yeah", "yes", "yep", "ok", "okay", "uh-huh", "mm-hmm", "right", "sure", "got it",
    ],
    interruptionPhrases: ["stop", "wait", "hold on", "hang on", "no no"],
  },
};

/** Deep-merge partial overrides (e.g. from a JSON file) into the defaults. */
export function makeConfig(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    ...defaultConfig,
    ...overrides,
    startSpeakingPlan: { ...defaultConfig.startSpeakingPlan, ...overrides.startSpeakingPlan },
    stopSpeakingPlan: { ...defaultConfig.stopSpeakingPlan, ...overrides.stopSpeakingPlan },
  };
}
