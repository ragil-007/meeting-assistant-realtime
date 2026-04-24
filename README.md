# Meeting-Assistant-Realtime

A real-time AI meeting copilot that listens to live audio, transcribes speech, and continuously surfaces contextual suggestions — questions to ask, insights to share, claims to fact-check, and actions to take — while you're in the meeting.

Built as a take-home assignment for [TwinMind](https://twinmind.com).

![Stack](https://img.shields.io/badge/Next.js-15-black?logo=next.js) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript) ![Tailwind](https://img.shields.io/badge/Tailwind-3-38bdf8?logo=tailwindcss) ![Groq](https://img.shields.io/badge/Groq-LLaMA%20%2B%20Whisper-orange)

---

## 🔗 Live Demo

🚀 Try the app here:
https://meeting-assistant-realtime-letz.vercel.app/


## What It Does

**Transcript (left column)** — Captures live mic audio and transcribes it in chunks using Whisper Large V3 via Groq. Auto-scrolls as new content arrives.

**Live Suggestions (middle column)** — Every ~30 seconds (or on manual refresh), the transcript is analyzed and 3 contextual suggestions are generated. Each suggestion has a short preview that delivers standalone value, and clicking it opens a detailed expansion in chat. Suggestions adapt to what's happening right now:

| Type | When it appears |
|---|---|
| `answer` | A question was just asked |
| `fact-check` | A factual or technical claim was made |
| `insight` | A concept was introduced or something important was skipped |
| `question` | A decision is being made or there's an unaddressed gap |
| `action` | A commitment was made and a next step is needed |

**Chat (right column)** — Click any suggestion to expand it, or type your own question. The assistant has full transcript context and responds in 2-3 sentences. One continuous chat per session.

**Export** — Export the full session (transcript + all suggestion batches + full chat history with timestamps) as JSON or plain text.

**Settings** — Paste your own Groq API key. Edit all prompts and context window sizes live.

---

## Demo

> Start the mic, speak naturally, and suggestions appear within ~30 seconds based on what you said.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS |
| Transcription | Groq — Whisper Large V3 |
| Suggestions & Chat | Groq — LLaMA (`llama-3.3-70b-versatile`) |
| Deployment | Vercel |

All AI calls go through Groq. No other AI providers. No database. No auth.

---

## Getting Started

### Prerequisites

- Node.js 18+
- A [Groq API key](https://console.groq.com) (free tier works)

### Local Setup

```bash
# Clone the repo
git clone https://github.com/your-username/meeting-assistant-realtime.git
cd meeting-assistant-realtime

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste your Groq API key in Settings, and click **Start Mic**.

No `.env` file needed — the API key is entered in the UI and never stored server-side.

---

## Project Structure

```
app/
├── api/
│   ├── chat/route.ts          # Streaming chat + suggestion expansion
│   ├── suggestions/route.ts   # Live suggestion generation
│   ├── transcribe/route.ts    # Whisper transcription
│   ├── memory/route.ts        # Session memory summarization
│   └── validate-key/route.ts  # Groq API key validation
├── components/
│   ├── TranscriptPanel.tsx    # Mic control + live transcript
│   ├── SuggestionsPanel.tsx   # Live suggestion batches
│   ├── ChatPanel.tsx          # Chat with streaming responses
│   ├── MicButton.tsx          # Audio capture + chunking
│   └── SettingsPanel.tsx      # API key + prompt editor
├── settings/                  # Default prompt constants
├── page.tsx                   # Root layout and state
└── globals.css
```

---

## Prompt Strategy

This is the core of the assignment. Here's how the prompts are structured and why.

### Suggestion Generation (`api/suggestions/route.ts`)

**Context passed to the model:**
- Last ~300 words of transcript (broad context window)
- Last ~60 words (recency focus — what just happened)
- Detected conversation mode (`technical discussion`, `decision-making`, `interview`, etc.)
- Detected surface signals from the last 60 seconds

**Signal detection drives type selection.** Rather than generating 3 questions every time, the route detects what just happened and chooses types accordingly:

```
question just asked   → answer + follow-up question + insight
factual claim made    → fact-check + insight + question
decision committed    → question exposing unknowns + action + insight
concept introduced    → insight + answer to "so what?" + question
uncertainty expressed → answer + question finding the root + insight
```

This produces a mix that matches the moment rather than a fixed quota.

**Grounding rule:** Every suggestion must reference something actually said — a named technology, person, decision, or metric. Generic suggestions that could appear in any meeting are explicitly banned in the prompt.

**Brevity enforcement:** The `full` field is capped at 2 sentences in the prompt *and* hard-truncated at the data layer via `truncateToSentences()`. Two controls because models frequently ignore length constraints in prompts.

**Custom prompt override:** User-provided prompts are injected *before* the type rules with explicit `⚠️ HIGHEST PRIORITY` framing. If the custom prompt specifies types (e.g. "generate questions only"), the default type distribution is suppressed so the two instructions don't conflict.

### Chat + Expansion (`api/chat/route.ts`)

Two prompt modes, switched by detecting the `[TYPE]` prefix on the user message:

**Suggestion expansion** (`isSuggestionClick = true`): Tight 2-3 sentence response. "Like a trusted colleague whispering the key point across the table." The participant is in a live meeting — brevity is the constraint.

**Freeform chat**: 2-4 sentences for simple questions, more for complex ones. The transcript context is included so answers are grounded in what was discussed.

**Anti-hallucination:** Both prompts include an explicit rule against inventing specific numbers, product names, or timeframes not present in the transcript. A wrong specific is worse than no specific.

**Temperature:** `0.35` for chat (precision over variety), `0.5` for suggestions (variety across batches, still grounded).

### Why These Tradeoffs

| Decision | Rationale |
|---|---|
| Signal detection over fixed type quotas | A question just asked needs an answer, not another question. Quotas ignore context. |
| `full` capped at 2 sentences in the data layer | Models ignore length constraints in prompts ~30% of the time. Two enforcement layers is the right call. |
| Custom prompt injected before type rules | LLMs weight later content more heavily. Appending at the end (the naive approach) means the hardcoded rules always win. |
| Total word count for auto-trigger threshold | Windowed slice word count can *decrease* as old chunks leave the window, permanently blocking auto-trigger. Total count only ever increases. |
| `isFetchingRef` separate from `activeId` | Suggestion fetching and chat streaming are independent operations. One shared lock causes suggestion auto-generation to freeze after any suggestion click error. |

---

## Key Engineering Decisions

**Rate limiting:** Groq's 429 responses include a `retryAfter` field in the error body. Both routes parse this and wait exactly that long before retrying once. If the wait exceeds 8 seconds, fallbacks are returned immediately rather than stalling the UI. The frontend shows a countdown timer during the lockout period.

**Streaming:** Chat responses stream token-by-token using `ReadableStream` + `getReader()`. The 8ms yield between tokens lets React batch DOM updates without dropping tokens.

**Auto-trigger guard:** `isFetchingRef` is a ref (not state) because state updates are async and can be stale inside callbacks, allowing a second fetch to slip through before the first sets the flag.

**Fallback suggestions:** When the model returns fewer than 3 valid suggestions (or the rate limit wait is too long), mode-aware fallbacks are returned. They're question-heavy by default — questions remain useful even without full context because they prompt the participant to think.

---

## Limitations & Known Issues

- No persistent storage — session data is lost on page reload (by design per spec)
- Whisper transcription has ~1-2s latency per chunk; very fast speech may produce fragmented chunks
- Groq free tier has rate limits (~30 req/min); rapid manual refreshes will hit the cooldown
- Mobile browser mic access requires HTTPS (works on Vercel, requires `--https` flag locally)

---

## What I'd Improve With More Time

- **Cross-batch deduplication** — the current deduplication is within-batch only; back-to-back batches on similar content can produce near-identical suggestions
- **Speaker diarization** — distinguishing who said what would significantly improve suggestion quality in multi-speaker meetings
- **Suggestion ranking** — surface the single highest-value suggestion more prominently rather than treating all 3 equally
- **Streaming suggestions** — pipe suggestion tokens as they arrive rather than waiting for the full JSON array, reducing perceived latency

---

## Author

Ragil