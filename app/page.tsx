"use client";

import { useState, useCallback, useEffect } from "react";
import TranscriptPanel from "./components/TranscriptPanel";
import SuggestionsPanel from "./components/SuggestionsPanel";
import ChatPanel from "./components/ChatPanel";
import SettingsPanel from "./components/SettingsPanel";

import {
  Message,
  TranscriptChunk,
  SuggestionBatch,
} from "@/types";

export default function Home() {
  const [transcriptChunks, setTranscriptChunks] =
    useState<TranscriptChunk[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestionBatches, setSuggestionBatches] =
    useState<SuggestionBatch[]>([]);

  const [isRecording, setIsRecording] = useState(false);

  const [memory, setMemory] = useState({
    summary: "",
    topics: [],
    lastUpdated: 0,
  });

  const [settings, setSettings] = useState({
    apiKey: "",
    suggestionPrompt: `
Generate highly relevant, context-aware suggestions.

Focus on:
- What is unclear
- What decision is being made
- What action should happen next

Avoid generic suggestions.
Each suggestion must be specific to the conversation.
`,
    expandPrompt: `
Convert this into something I can say in a meeting.

- Natural spoken tone
- Confident
- Max 3 sentences
- No fluff
`,
    chatPrompt: `
Answer clearly and concisely.

- Max 3 sentences
- Focus on what matters now
- No unnecessary explanation
`,
    suggestionContext: 3,
    chatContext: 6,
  });

  const [settingsReady, setSettingsReady] = useState(false);

  // ✅ LOAD SETTINGS
  useEffect(() => {
    try {
      const saved = localStorage.getItem("app_settings");
      if (saved) {
        setSettings(JSON.parse(saved));
      }
    } catch {
      console.error("Failed to load settings");
    } finally {
      setSettingsReady(true);
    }
  }, []);

  // ✅ CLEAR
  const handleClear = useCallback(() => {
    setTranscriptChunks([]);
    setMessages([]);
    setSuggestionBatches([]);
    setMemory({
      summary: "",
      topics: [],
      lastUpdated: 0,
    });
  }, []);

  // ✅ EXPORT JSON (unchanged)
  const handleExport = useCallback(() => {
    const data = {
      metadata: {
        exportedAt: new Date().toISOString(),
      },
      transcript: transcriptChunks,
      suggestions: suggestionBatches,
      chat: messages,
      memory,
      settings,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [transcriptChunks, suggestionBatches, messages, memory, settings]);

  // 🔥 FIXED EXPORT TEXT (WITH SUGGESTIONS)
  const handleExportText = useCallback(() => {
    let text = "=== TRANSCRIPT ===\n\n";

    // 📝 TRANSCRIPT
    transcriptChunks.forEach((t) => {
      text += `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.text}\n\n`;
    });

    // 💡 SUGGESTIONS
    text += "\n=== SUGGESTIONS ===\n\n";

    if (suggestionBatches.length === 0) {
      text += "No suggestions generated.\n\n";
    } else {
      suggestionBatches.forEach((batch, batchIndex) => {
        text += `--- Batch ${batchIndex + 1} (${new Date(
          batch.timestamp
        ).toLocaleTimeString()}) ---\n\n`;

        batch.items.forEach((s, i) => {
          text += `(${i + 1}) [${s.type.toUpperCase()}]\n`;
          text += `Preview: ${s.preview}\n`;
          text += `Full: ${s.full}\n`;
          text += `Score: ${s.score}\n\n`;
        });

        text += "-----------------------------\n\n";
      });
    }

    // 💬 CHAT
    text += "\n=== CHAT ===\n\n";

    messages.forEach((m) => {
      text += `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.role}: ${m.content}\n\n`;
    });

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${Date.now()}.txt`;
    a.click();

    URL.revokeObjectURL(url);
  }, [transcriptChunks, suggestionBatches, messages]);

  if (!settingsReady) {
    return (
      <div className="h-screen flex items-center justify-center text-white bg-black">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="h-screen bg-black text-white overflow-hidden flex flex-col relative">

      <button
        onClick={handleClear}
        className="absolute top-4 left-4 bg-red-600 px-3 py-1 rounded hover:bg-red-500 z-20 text-sm"
      >
        Clear
      </button>

      <div className="flex-1 grid grid-cols-4 gap-4 p-4 min-h-0 overflow-hidden">

        <div className="flex flex-col min-h-0 overflow-hidden">
          <TranscriptPanel
            transcriptChunks={transcriptChunks}
            setTranscriptChunks={setTranscriptChunks}
            isRecording={isRecording}
            setIsRecording={setIsRecording}
            settings={settings}
          />
        </div>

        <div className="flex flex-col min-h-0 overflow-hidden">
          <SuggestionsPanel
            transcriptChunks={transcriptChunks}
            messages={messages}
            setMessages={setMessages}
            suggestionBatches={suggestionBatches}
            setSuggestionBatches={setSuggestionBatches}
            memory={memory}
            setMemory={setMemory}
            isRecording={isRecording}
            settings={settings}
          />
        </div>

        <div className="flex flex-col min-h-0 overflow-hidden">
          <ChatPanel
            messages={messages}
            setMessages={setMessages}
            transcriptChunks={transcriptChunks}
            onExportJSON={handleExport}
            onExportTXT={handleExportText}
            settings={settings}
          />
        </div>

        <div className="flex flex-col min-h-0 overflow-hidden">
          <SettingsPanel
            settings={settings}
            setSettings={setSettings}
          />
        </div>

      </div>
    </div>
  );
}