export function buildSuggestionPrompt(transcript: string[]) {
  return `
You are a meeting assistant.

Based on the transcript below, generate:
- 2 smart answers
- 2 relevant questions
- 1 useful insight

Make them:
- Specific
- Context-aware
- Professional

Return ONLY JSON array:
[
  { "type": "answer", "text": "..." },
  { "type": "question", "text": "..." },
  { "type": "insight", "text": "..." }
]

Transcript:
${transcript.join(" ")}
`;
}