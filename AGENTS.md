# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# TTML API — Expo Client Integration Guide

## Base URL

Production: `https://ttml-lyrics-aligner.<your-worker>.workers.dev`

## API Surface

### 1. POST /align

Submit a track for alignment.

```typescript
// Request
{
  trackId: string;       // your internal track ID (used as R2 key)
  audioUrl: string;      // signed audio URL (YouTube, etc.) — IP-bound, short-lived
  lyrics: string;        // full lyrics text, newline-separated lines
  language?: string;     // optional, e.g. "en", "es" — passed to Whisper
}

// Response 200 — already cached
{ status: "cached", ttmlUrl: "ttml/:trackId.ttml" }

// Response 202 — job queued
{ status: "queued", jobId: string }

// Response 429 — rate limited
{ error: "rate limit exceeded, try again in 60s" }

// Response 400
{ error: "trackId, audioUrl, and lyrics are required" }
```

**Important:** `audioUrl` must be a **freshly fetched** signed URL. YouTube URLs expire in 1–6h and are IP-bound. Fetch a new one moments before calling `/align`.

**Sync bypass for dev:** Append `?sync` to run alignment inline (skips queue). Returns `{ status: "done", ttmlUrl }` directly.

### 2. GET /status/:jobId

Poll for completion. `jobId` is the `jobId` from `/align` response.

```typescript
// Response — still processing
{ status: "pending" }

// Response — done
{ status: "done", ttmlUrl: "ttml/:trackId.ttml" }

// Response — error
{ status: "error", error: string }
```

Poll every 2–3s. Typical alignment time: 5–15s.

### 3. GET /ttml/:trackId

Fetch the aligned TTML directly. No auth — served from R2.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    itunes:timing="Word">
  <body>
    <div>
      <p begin="00:12.450" end="00:13.200">
        <span begin="00:12.450" end="00:12.780">Midnight</span>
        <span begin="00:12.780" end="00:13.200">rain</span>
      </p>
    </div>
  </body>
</tt>
```

Each `<p>` = one lyric line. Each `<span>` = one word with `itunes:timing="Word"`.

## Rate Limiting

Send `X-Device-ID` header with a stable device UUID:

```typescript
headers: {
  "Content-Type": "application/json",
  "X-Device-ID": deviceUUID,  // from expo-device or AsyncStorage
}
```

- **With header** → rate-limited by device UUID (20 req/min default)
- **Without header** → rate-limited by IP (same limit)
- Falls back to IP so curl tests still work

## TTML Parsing (Expo)

Use `fast-xml-parser` (~6KB, no native deps) to parse the TTML into typed arrays for animation:

```typescript
import { XMLParser } from "fast-xml-parser";

interface WordSpan {
  word: string;
  begin: number;   // seconds
  end: number;     // seconds
}

interface LyricLine {
  begin: number;
  end: number;
  words: WordSpan[];
  text: string;
}

function parseTTML(xml: string): LyricLine[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const doc = parser.parse(xml);
  const paragraphs = doc.tt.body.div.p;
  const lines = Array.isArray(paragraphs) ? paragraphs : [paragraphs];

  return lines.map((p: any) => {
    const spans = Array.isArray(p.span) ? p.span : [p.span];
    const words: WordSpan[] = spans.map((s: any) => ({
      word: s["#text"],
      begin: parseTTMLTime(s["@_begin"]),
      end: parseTTMLTime(s["@_end"]),
    }));
    return {
      begin: parseTTMLTime(p["@_begin"]),
      end: parseTTMLTime(p["@_end"]),
      words,
      text: words.map((w) => w.word).join(" "),
    };
  });
}

function parseTTMLTime(t: string): number {
  // "00:12.450" → 12.45
  const [m, s] = t.split(":");
  return parseInt(m) * 60 + parseFloat(s);
}
```

## End-to-End Client Flow

```typescript
// 1. Fetch a fresh audio URL for the track
const audioUrl = await fetchSignedUrl(trackId);

// 2. Request alignment (with retries on 429)
const res = await fetch(`${BASE_URL}/align`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Device-ID": deviceUUID,
  },
  body: JSON.stringify({ trackId, audioUrl, lyrics }),
});

if (res.status === 200) {
  // cached — fetch TTML directly
  const { ttmlUrl } = await res.json();
  return fetchTTML(ttmlUrl);
}

if (res.status === 202) {
  // queued — poll /status/:jobId
  const { jobId } = await res.json();
  return pollStatus(jobId);
}

// 3. Poll until done (or timeout after 60s)
async function pollStatus(jobId: string, timeout = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await fetch(`${BASE_URL}/status/${jobId}`);
    const data = await res.json();
    if (data.status === "done") return fetchTTML(data.ttmlUrl);
    if (data.status === "error") throw new Error(data.error);
    await delay(2000);
  }
  throw new Error("Alignment timed out");
}

// 4. Parse TTML
const lines = parseTTML(xml);

// 5. Local cache
await AsyncStorage.setItem(`ttml:${trackId}`, JSON.stringify(lines));
```

## Caching

- **Local (AsyncStorage):** Cache parsed `LyricLine[]` per `trackId` — never re-fetch for the same track
- **Server-side (KV):** `/align` returns 200 immediately if already aligned (TTL: 30 days)
- **R2:** TTML files cached with `max-age=2592000` (30 days)
- **Always fetch a fresh audio URL** even if cached on server — the server uses the URL you send

## Per-Word Sweep Animation

Each word's sweep duration = `(word.end - word.begin) * 1000` ms with `Easing.linear`.

```typescript
// For the active line, animate each word's progress independently
words.forEach((word, i) => {
  const duration = (word.end - word.begin) * 1000;
  // Animate fill width from 0 to measured word width
  // On seek: cancel all animations, recalculate progress from currentTime
});
```

Layout: `flexWrap: "wrap"` row, each word wrapped in a `View` with `onLayout` to measure width.

On seek/scrub: cancel all active animations, recalculate each word's progress from `currentTime`, restart from that point.
