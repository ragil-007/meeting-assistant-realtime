"use client";

import { useEffect, useRef, useState } from "react";

type TranscriptChunk = {
  text: string;
  timestamp: number;
};

interface Props {
  transcriptChunks: TranscriptChunk[];
  setTranscriptChunks: React.Dispatch<
    React.SetStateAction<TranscriptChunk[]>
  >;

  isRecording: boolean;
  setIsRecording: React.Dispatch<React.SetStateAction<boolean>>;

  settings: {
    apiKey: string;
  };
}

export default function TranscriptPanel({
  transcriptChunks = [],
  setTranscriptChunks,
  isRecording,
  setIsRecording,
  settings,
}: Props) {
  const [liveText, setLiveText] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const liveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isRecordingRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 🔥 API KEY
  const apiKey = settings?.apiKey?.trim();
  const hasApiKey = !!apiKey && apiKey.length > 10;

  // 🧠 SMART AUTO-SCROLL (FIXED)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (autoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcriptChunks, liveText, autoScroll]);

  // 👀 Detect manual scroll
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;

    setAutoScroll(nearBottom);
  };

  // 🧠 Send chunk
  const handleTranscription = async (blob: Blob) => {
    if (!hasApiKey || blob.size === 0) return;

    try {
      const file = new File([blob], "chunk.webm", {
        type: "audio/webm",
      });

      const formData = new FormData();
      formData.append("audio", file);
      formData.append("apiKey", apiKey);

      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) return;

      const data = await res.json();

      if (data.text) {
        setTranscriptChunks((prev) => [
          ...prev,
          { text: data.text, timestamp: Date.now() },
        ]);
        setLiveText("");
      }
    } catch (err) {
      console.error("Transcription error:", err);
    }
  };

  const startRecorder = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    const mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        await handleTranscription(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (isRecordingRef.current) {
        mediaRecorder.start();
        mediaRecorderRef.current = mediaRecorder;
      }
    };

    mediaRecorder.start();
    mediaRecorderRef.current = mediaRecorder;
  };

  const handleToggleRecording = async () => {
    if (!hasApiKey) {
      alert("Set API key first!");
      return;
    }

    if (!isRecording) {
      await startRecorder();

      isRecordingRef.current = true;
      setIsRecording(true);

      intervalRef.current = setInterval(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      }, 30000);

      liveIntervalRef.current = setInterval(() => {
        setLiveText((prev) => prev + " .");
      }, 2000);
    } else {
      isRecordingRef.current = false;
      setIsRecording(false);

      mediaRecorderRef.current?.stop();

      if (intervalRef.current) clearInterval(intervalRef.current);
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);

      intervalRef.current = null;
      liveIntervalRef.current = null;

      setLiveText("");
    }
  };

  // 🧹 Cleanup
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
    };
  }, []);

  return (
    <div className="border rounded-xl p-4 h-full flex flex-col min-h-0">

      {/* 🔥 FIXED HEADER */}
      <div className="flex-shrink-0">
        <h2 className="font-semibold mb-2">Transcript</h2>

        <button
          onClick={handleToggleRecording}
          className={`px-3 py-2 rounded ${
            isRecording ? "bg-red-600" : "bg-blue-600"
          }`}
        >
          {isRecording ? "Stop Recording" : "Start Mic"}
        </button>

        {isRecording && (
          <p className="text-green-400 text-xs mt-2">
            🎙 Listening...
          </p>
        )}
      </div>

      {/* 🔥 ISOLATED SCROLL AREA */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto space-y-2 pr-1 mt-3 min-h-0"
      >
        {transcriptChunks.length === 0 ? (
          <p className="text-gray-500 text-sm">
            Speak to see transcript here...
          </p>
        ) : (
          transcriptChunks.map((chunk) => (
            <div key={chunk.timestamp} className="text-sm">
              {chunk.text}
            </div>
          ))
        )}

        {isRecording && liveText && (
          <div className="text-sm text-gray-400 italic">
            {liveText}
          </div>
        )}
      </div>
    </div>
  );
}