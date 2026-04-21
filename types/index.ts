export type TranscriptChunk = {
  text: string;
  timestamp: number;
};

export type Suggestion = {
  type: "question" | "insight" | "action";
  preview: string;
  full: string;
  score: number; // ✅ NEW
};

export type SuggestionBatch = {
  id: number;
  timestamp: number;
  items: Suggestion[];
  sourceHash: string; // 🔥 REQUIRED (for dedupe logic)
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};