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
  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestionBatches, setSuggestionBatches] = useState<SuggestionBatch[]>([]);

  const [isRecording, setIsRecording] = useState(false);

  // 🧠 MEMORY
  const [memory, setMemory] = useState({
    summary: "",
    topics: [],
    lastUpdated: 0,
  });

  // 🔥 SETTINGS
  const [settings, setSettings] = useState({
    apiKey: "",
    suggestionPrompt: "Generate sharp, non-generic suggestions.",
    expandPrompt: "Expand naturally, max 3 sentences, no fluff.",
    chatPrompt: "Answer clearly, concisely, max 3 sentences.",
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

  // ✅ EXPORT JSON
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

  // ✅ EXPORT TEXT
  const handleExportText = useCallback(() => {
    let text = "=== TRANSCRIPT ===\n\n";

    transcriptChunks.forEach((t) => {
      text += `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.text}\n\n`;
    });

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
  }, [transcriptChunks, messages]);

  if (!settingsReady) {
    return (
      <div className="h-screen flex items-center justify-center text-white bg-black">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="h-screen bg-black text-white overflow-hidden flex flex-col relative">

      {/* CLEAR BUTTON */}
      <button
        onClick={handleClear}
        className="absolute top-4 left-4 bg-red-600 px-3 py-1 rounded hover:bg-red-500 z-20"
      >
        Clear
      </button>

      {/* 🔥 CRITICAL FIX: min-h-0 */}
      <div className="flex-1 grid grid-cols-4 gap-4 p-4 min-h-0">

        {/* TRANSCRIPT */}
        <div className="flex flex-col min-h-0">
          <TranscriptPanel
            transcriptChunks={transcriptChunks}
            setTranscriptChunks={setTranscriptChunks}
            isRecording={isRecording}
            setIsRecording={setIsRecording}
            settings={settings}
          />
        </div>

        {/* SUGGESTIONS */}
        <div className="flex flex-col min-h-0">
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

        {/* CHAT */}
        <div className="flex flex-col min-h-0">
          <ChatPanel
            messages={messages}
            setMessages={setMessages}
            transcriptChunks={transcriptChunks}
            onExportJSON={handleExport}
            onExportTXT={handleExportText}
            settings={settings}
          />
        </div>

        {/* SETTINGS */}
        <div className="flex flex-col min-h-0">
          <SettingsPanel
            settings={settings}
            setSettings={setSettings}
          />
        </div>

      </div>
    </div>
  );
}