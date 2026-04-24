import { NextResponse } from "next/server";
import { getGroqClient } from "@/lib/groq";

// 🔁 retry helper (same pattern as other routes)
async function callWithRetry(fn: () => Promise<any>, retries = 2) {
  try {
    return await fn();
  } catch (err: any) {
    if (err?.status === 429 && retries > 0) {
      const retryAfter =
        err?.headers?.get?.("retry-after") || 2;

      await new Promise((r) =>
        setTimeout(r, retryAfter * 1000)
      );

      return callWithRetry(fn, retries - 1);
    }
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const audioFile = formData.get("audio") as File;
    const apiKey = formData.get("apiKey") as string;

    // 🔒 VALIDATION
    if (!audioFile || !apiKey || apiKey.length < 20) {
      return NextResponse.json(
        { error: "Invalid request" },
        { status: 400 }
      );
    }

    const groq = getGroqClient(apiKey.trim());

    let response;

    try {
      response = await callWithRetry(() =>
        groq.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-large-v3",
        })
      );
    } catch (err: any) {
      if (err?.status === 429) {
        const retryAfter =
          err?.headers?.get?.("retry-after") || 5;

        return NextResponse.json(
          {
            error: "RATE_LIMIT",
            message: `Too many requests. Try again in ${retryAfter}s.`,
            retryAfter,
          },
          { status: 429 }
        );
      }

      // 🔒 SAFE LOG (no sensitive data)
      if (process.env.NODE_ENV === "development") {
        console.error("Groq error (transcribe)");
      }

      return NextResponse.json(
        { error: "Transcription failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({ text: response.text });
  } catch {
    // 🔒 SAFE LOG
    if (process.env.NODE_ENV === "development") {
      console.error("Transcribe route failed");
    }

    return NextResponse.json(
      { error: "Unexpected error" },
      { status: 500 }
    );
  }
}