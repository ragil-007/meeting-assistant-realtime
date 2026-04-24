export type TranscriptChunk = {
  text: string;
  timestamp: number;
};

export type Suggestion = {
  type: "question" | "insight" | "action" | "fact-check" | "answer";
  preview: string;
  full: string;
  score?: number;
};

export type SuggestionBatch = {
  id: number;
  timestamp: number;
  items: Suggestion[];
  sourceHash?: string;
  wasRateLimited?: boolean;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};