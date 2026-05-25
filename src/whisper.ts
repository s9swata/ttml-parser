import { WhisperWord, Env } from "./types";

export async function runWhisper(
  audioBuffer: ArrayBuffer,
  language: string | undefined,
  env: Env,
): Promise<WhisperWord[]> {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (language && language !== "en") form.append("language", language);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Groq Whisper API error ${res.status}: ${error}`);
  }

  const data = (await res.json()) as { words: WhisperWord[] };
  return data.words;
}
