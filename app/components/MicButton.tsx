"use client";

import { useRef, useState } from "react";

export default function MicButton({
  onChunkReady,
}: {
  onChunkReady: (blob: Blob) => void;
}) {
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        onChunkReady(event.data);
      }
    };

    recorder.start(30000);
    setRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  return (
    <button
      onClick={recording ? stopRecording : startRecording}
      className="bg-blue-500 text-white px-4 py-2 rounded"
    >
      {recording ? "Stop" : "Start Mic"}
    </button>
  );
}