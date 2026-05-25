# TTML Lyrics Alignment Engine — Cloudflare-native Architecture

## Overview

A serverless microservice built entirely on Cloudflare primitives that takes a
track's audio URL and known lyrics text, generates per-word TTML timestamps via
Groq Cloud Whisper (free tier), and serves the result to the app for Apple Music-style
word-level sweep animations.

No persistent servers. No ML infra to manage. Pay per request.

---

## Why Cloudflare Workers (and why not for Whisper)

| Concern | Reality |
|---|---|
| Workers CPU limit | 30s — Whisper inference needs 5–30s+ depending on model |
| Workers memory limit | 128MB — Whisper models are 150MB–1.5GB |
| Conclusion | Workers cannot run Whisper directly |
| Solution | Workers as gateway + queue + cache. Whisper runs via OpenAI API |

Workers handle everything except inference. Groq Cloud's free
`/v1/audio/transcriptions` (OpenAI-compatible) with `timestamp_granularities=["word"]`
runs `whisper-large-v3`. No VPS needed.

---

## Full Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        React Native App                      │
└───────────────┬─────────────────────────────────────────────┘
                │ POST /align  { trackId, audioUrl, lyrics }
                ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker — API Gateway                 │
│                                                             │
│  1. Hash key = sha256(trackId + lyricsFingerprint)          │
│  2. Check KV for cached TTML URL  ──── HIT ──► return URL   │
│  3. MISS → enqueue job to Cloudflare Queue                  │
│  4. Return 202 { jobId, pollUrl }                           │
└───────────────┬─────────────────────────────────────────────┘
                │ enqueue
                ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Queue                                │
│  Batch size: 1   Retry: 3   Visibility timeout: 60s         │
└───────────────┬─────────────────────────────────────────────┘
                │ triggers
                ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker — Queue Consumer              │
│                                                             │
│  1. Fetch audio (audioUrl → ArrayBuffer)                    │
│  2. POST to Groq Cloud Whisper API                          │
│     (whisper-large-v3, free tier)                           │
│     → word-level timestamps JSON                            │
│  3. Diff Whisper words against known lyrics text            │
│     → force-aligned word list                               │
│  4. Build TTML XML string                                   │
│  5. PUT to Cloudflare R2  (ttml/{trackId}.ttml)             │
│  6. Write R2 public URL to KV  (TTL: 30 days)              │
└───────────────┬─────────────────────────────────────────────┘
                │ KV written
                ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Worker — Poll Endpoint               │
│   GET /status/:jobId                                        │
│   → checks KV for completion → returns { status, ttmlUrl }  │
└─────────────────────────────────────────────────────────────┘
                │ ttmlUrl ready
                ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare R2  (public bucket)                  │
│   App fetches TTML directly from R2 CDN URL                 │
│   Cache-Control: public, max-age=2592000 (30 days)          │
└─────────────────────────────────────────────────────────────┘
```

---

## Cloudflare Primitives Used

| Primitive | Purpose |
|---|---|
| **Workers** | API gateway, queue consumer, poll endpoint |
| **Queues** | Async job dispatch — decouples API response from Whisper latency |
| **KV** | Cache layer — `ttml:{hash}` → R2 URL, TTL 30 days |
| **R2** | Persistent TTML file storage, CDN-served to app |
| **Workers AI** | NOT used — Whisper via Groq free tier is cheaper and better |

---

## Groq Cloud Whisper Integration

### Why Groq over whisper.cpp / OpenAI

| | Groq Cloud (free) | whisper.cpp on VPS | OpenAI API |
|---|---|---|---|
| Infra | Zero | Fly.io / Hetzner box | Zero |
| Speed | ~3–8s per song | ~8–25s (CPU, medium model) | ~5–10s per song |
| Cost | **$0** (free tier) | ~$4–6/month fixed | $0.006/min audio |
| Model | `whisper-large-v3` | user choice | `whisper-1` |
| Rate limits | 20 req/min, 14k req/day | None | 3,500s/min (T1) |
| Word timestamps | Native | Needs extra flags | Native |
| Verdict | ✅ Use this | Only if rate limits hit | Only if Groq down |

Groq free tier covers **14k audio alignments/day** at $0 — the only cost is Cloudflare resources.

### API Call (inside Queue Consumer Worker)

```typescript
async function runWhisper(
  audioBuffer: ArrayBuffer,
  language: string
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

  const data = await res.json();
  // data.words = [{ word, start, end }, ...]
  return data.words;
}
```

Cost example: 10,000 song alignments × avg 3.5 min = **$0 total** (free tier).

---

## Force-Alignment Diff (Whisper → Ground Truth)

Whisper transcribes audio freely — it may mishear words, hallucinate, or skip
lines. Since we have the ground-truth lyrics from LRCLib, we correct Whisper's
output before building TTML.

### Algorithm

```typescript
import { diffWords } from "diff"; // ~3KB, runs fine in Workers

interface AlignedWord {
  word: string;
  start: number; // seconds
  end: number;
  confidence: "exact" | "interpolated";
}

function forceAlign(
  whisperWords: WhisperWord[],  // what Whisper heard
  groundTruth: string[]         // known lyrics words
): AlignedWord[] {
  // 1. Normalize both sequences (lowercase, strip punctuation)
  // 2. Run sequence diff to find matched / inserted / deleted words
  // 3. For matched words: borrow Whisper start/end directly
  // 4. For unmatched words: linear interpolation between
  //    the surrounding matched anchors
  // 5. Return full aligned sequence matching groundTruth exactly
}
```

### Example

```
Ground truth:  ["Midnight", "rain",  "falls", "on", "the", "window"]
Whisper heard: ["Midnight", "reins", "falls", "on", "the", "window"]
                            ↑ mishear

Result:
  "Midnight" → exact   (00:12.45 – 00:13.20)
  "rain"     → interpolated from gap between Midnight and falls
  "falls"    → exact   (00:13.60 – 00:14.10)
  ...
```

---

## TTML Builder

```typescript
function buildTTML(lines: LyricLine[], alignedWords: AlignedWord[]): string {
  // 1. Group alignedWords back into their original LRC lines
  //    by matching word index ranges
  // 2. For each line, emit a <p begin end> with <span> per word
  // 3. Wrap in W3C TTML boilerplate with itunes:timing="Word"

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xml:lang="en"
    xmlns="http://www.w3.org/ns/ttml"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    itunes:timing="Word">
  <body>
    <div>
      ${lines.map(renderLine).join("\n      ")}
    </div>
  </body>
</tt>`;
}

function toTTMLTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
  // e.g. 00:12.450
}
```

---

## KV Schema

```
Key:    ttml:{sha256(trackId + lyricsText[:64])}
Value:  {
          status: "pending" | "done" | "error",
          ttmlUrl: "https://pub-xxx.r2.dev/ttml/abc123.ttml",
          alignedAt: 1716000000,
          trackId: "abc123"
        }
TTL:    2592000s  (30 days)
```

---

## R2 Storage

```
Bucket:       lyrics-ttml  (public)
Key pattern:  ttml/{trackId}.ttml
Headers:      Content-Type: application/ttml+xml
              Cache-Control: public, max-age=2592000
```

App fetches the R2 URL directly — no Worker in the hot path once aligned.

---

## App-side Integration

### 1. Request alignment on track load

```typescript
async function ensureTTML(trackId: string, audioUrl: string, lyrics: string) {
  // Check local AsyncStorage first
  const cached = await AsyncStorage.getItem(`ttml:${trackId}`);
  if (cached) return cached;

  const res = await fetch("https://lyrics.yourworker.dev/align", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId, audioUrl, lyrics }),
  });

  if (res.status === 200) {
    // Already cached — URL returned immediately
    const { ttmlUrl } = await res.json();
    await AsyncStorage.setItem(`ttml:${trackId}`, ttmlUrl);
    return ttmlUrl;
  }

  if (res.status === 202) {
    // Job queued — poll until ready
    const { jobId } = await res.json();
    return pollUntilReady(jobId, trackId);
  }
}
```

### 2. TTML Parser

```typescript
import { XMLParser } from "fast-xml-parser"; // lightweight, no native deps

interface WordSpan { word: string; begin: number; end: number; }
interface TTMLLine { begin: number; end: number; words: WordSpan[]; text: string; }

function parseTTML(xml: string): TTMLLine[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml);
  const paragraphs = doc.tt.body.div.p;

  return [paragraphs].flat().map((p: any) => {
    const spans = [p.span].flat();
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
  // "00:12.450" → 12.45 seconds
  const [m, s] = t.split(":");
  return parseInt(m) * 60 + parseFloat(s);
}
```

### 3. Per-word sweep animation

Each word in the active line gets its own `Animated.timing`:
- `duration = (word.end - word.begin) * 1000` ms
- `easing = Easing.linear`
- Sweep `fillAnim` from `0` → measured word width
- Words are laid out in a `flexWrap` row, each measured with `onLayout`
- On seek/scrub: cancel all, recalculate progress for each word, restart

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/align` | Submit alignment job |
| `GET` | `/status/:jobId` | Poll job status |
| `GET` | `/ttml/:trackId` | Direct TTML fetch (if cached) |

---

## Cost Estimate

| Volume | Whisper cost (Groq free tier) | Cloudflare cost |
|---|---|---|
| 1,000 songs/month | **$0** (within 14k/day limit) | Free tier covers it |
| 10,000 songs/month | **$0** | ~$0 (R2 free: 10GB, KV free: 100k reads) |
| 100,000 songs/month | **$0** | ~$5 (R2 egress + KV writes) |

Groq rate limits: 20 req/min, 14k req/day. Cloudflare Workers free tier: 100k requests/day.
Beyond free tier, Groq's paid tier is competitive with OpenAI. Alternatively, swap to
OpenAI API as fallback.

---

## Milestones

### v0.1 — Core pipeline ✅
- [x] Worker: `POST /align` → enqueue to Queue (with `?sync` bypass for dev)
- [x] Worker consumer: fetch audio → Groq Whisper → TTML → R2
- [x] Worker: `GET /status/:key` → KV poll
- [x] `GET /ttml/:trackId` → serve TTML from R2

### v0.2 — Accuracy ✅
- [x] Force-align diff against ground truth lyrics (via `diff` package)
- [x] Handle Whisper mishears + interpolation for gaps
- [ ] Language detection passthrough to Whisper (stretch)

### v0.3 — App integration
- [ ] `parseTTML` utility
- [ ] Per-word sweep in `LyricLine` component
- [ ] AsyncStorage cache for TTML URLs
- [ ] Graceful fallback to line-sweep if TTML unavailable

### v0.4 — Reliability ✅
- [x] Retry logic in Queue consumer (max 3 attempts, 10s delay between retries)
- [x] Error state in KV + surfaced to app via `/status/:key`
- [x] Audio size validation (reject > 25MB, configurable via `AUDIO_MAX_SIZE_MB`)
- [x] Rate limiting on `/align` endpoint (KV-based fixed window, 20 req/min default)

### v1.0 — Production
- [ ] Custom domain on Worker
- [ ] R2 public bucket with proper CORS headers
- [ ] Monitoring via Cloudflare Analytics
- [ ] Optional: whisper.cpp fallback on Fly.io if OpenAI quota exceeded
