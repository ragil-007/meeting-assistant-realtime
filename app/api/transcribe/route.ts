import { NextResponse } from "next/server";
import { getGroqClient } from "@/lib/groq";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const audioFile = formData.get("audio") as File;
    const apiKey = formData.get("apiKey") as string;

    console.log("Received API key:", apiKey);
    console.log("Length:", apiKey?.length);

    if (!audioFile || !apiKey) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const groq = getGroqClient(apiKey);

    const response = await groq.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-large-v3",
    });

    return NextResponse.json({ text: response.text });
  } catch (err) {
    console.error("Transcription error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}