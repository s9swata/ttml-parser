import { AlignedWord } from "./types";

export function buildTTML(words: AlignedWord[], lang: string): string {
  const begin = toTTMLTime(words[0]?.start ?? 0);
  const end = toTTMLTime(words[words.length - 1]?.end ?? 0);
  const spans = words
    .map(
      (w) =>
        `<span begin="${toTTMLTime(w.start)}" end="${toTTMLTime(w.end)}">${escapeXml(w.word)}</span>`,
    )
    .join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xml:lang="${lang}"
    xmlns="http://www.w3.org/ns/ttml"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    itunes:timing="Word">
  <body>
    <div>
      <p begin="${begin}" end="${end}">${spans}</p>
    </div>
  </body>
</tt>
`;
}

function toTTMLTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
