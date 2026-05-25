# TTML Lyrics Alignment Engine

Serverless per-word TTML timestamp generator. Takes an audio URL and known lyrics, produces Apple Music-style word-level timestamps via [Groq Cloud Whisper](https://groq.com) (free tier).

Built entirely on Cloudflare Workers — no servers, no ML infra, pay per request.

## How it works

```
POST /align  { trackId, audioUrl, lyrics }
  → 202 { jobId }

GET /status/:key
  → { status: "done", ttmlUrl: "..." }

GET /ttml/:trackId
  → application/ttml+xml  (direct from R2)
```

1. **Request** — submit audio URL + lyrics → job enqueued to Cloudflare Queue
2. **Align** — consumer fetches audio, runs Groq Whisper (`whisper-large-v3`), force-aligns word timestamps against your known lyrics
3. **Serve** — TTML stored in R2, poll `/status/:key` until ready, fetch directly from R2

## Force alignment

Whisper mishears words. The `diff`-based force-alignment corrects this:

| Ground truth | Whisper heard | Result |
|---|---|---|
| "rain" | "reins" | exact timing for "rain" (interpolated from neighbors) |
| "midnight" | "midnight" | exact timing borrowed from Whisper |

## Deploy

```bash
bun install
cp wrangler.toml.example wrangler.toml  # fill in KV namespace ID, bucket name
echo "your-groq-api-key" | wrangler secret put GROQ_API_KEY
bun run deploy
```

## Env vars

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | — | Groq Cloud API key (set via `wrangler secret`) |
| `RATE_LIMIT_PER_MINUTE` | `20` | Max `/align` requests per device/IP per minute |
| `AUDIO_MAX_SIZE_MB` | `25` | Max audio file size in MB |
| `CACHE_TTL_SECONDS` | `2592000` | KV/R2 cache TTL (30 days) |

## Rate limiting

- **Device-based** — app sends `X-Device-ID` header → keyed on device UUID
- **IP fallback** — curl/testing without the header falls back to `CF-Connecting-IP`
- Fixed window (60s), configurable via `RATE_LIMIT_PER_MINUTE`

## Development

```bash
bun run dev          # wrangler dev — add ?sync to /align to skip queue
bun run typecheck    # tsc --noEmit
```
