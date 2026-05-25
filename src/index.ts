import { AlignMessage, AlignRequest, AlignResponse, CacheEntry, Env, StatusResponse } from "./types";
import { runWhisper } from "./whisper";
import { forceAlign, parseLyrics } from "./align";
import { buildTTML } from "./ttml";

// ─── Helpers ─────────────────────────────────────────────────────

function lyricsFingerprint(lyrics: string): string {
  return lyrics.trim().slice(0, 64);
}

function kvKey(trackId: string, lyrics: string): string {
  return `${trackId}:${lyricsFingerprint(lyrics)}`;
}

function makeJobId(): string {
  return crypto.randomUUID();
}

function asNumber(val: string | undefined, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchAudio(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

// ─── Rate limiter ──────────────────────────────────────────────────

async function checkRateLimit(req: Request, env: Env): Promise<Response | null> {
  const limit = asNumber(env.RATE_LIMIT_PER_MINUTE, 20);
  const window = Math.floor(Date.now() / 60000);

  const deviceId = req.headers.get("X-Device-ID");
  const prefix = deviceId ? `device:${deviceId}` : `ip:${req.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  const key = `ratelimit:${prefix}:${window}`;

  const current = await env.TTML_CACHE.get<number>(key, "json");
  const count = (current ?? 0) + 1;

  if (count > limit) {
    return Response.json({ error: "rate limit exceeded, try again in 60s" }, { status: 429 });
  }

  await env.TTML_CACHE.put(key, JSON.stringify(count), { expirationTtl: 120 });
  return null;
}

// ─── Route: POST /align ──────────────────────────────────────────

async function handleAlign(request: AlignRequest, env: Env): Promise<Response> {
  const { trackId, audioUrl, lyrics, language } = request;

  if (!trackId || !audioUrl || !lyrics) {
    return Response.json({ error: "trackId, audioUrl, and lyrics are required" }, { status: 400 });
  }

  const key = kvKey(trackId, lyrics);
  const cached = await env.TTML_CACHE.get<CacheEntry>(key, "json");

  if (cached?.status === "done" && cached.ttmlUrl) {
    return Response.json({ status: "cached", ttmlUrl: cached.ttmlUrl } satisfies AlignResponse);
  }

  if (cached?.status === "pending") {
    return Response.json({ status: "queued", jobId: key } satisfies AlignResponse, { status: 202 });
  }

  const jobId = makeJobId();
  await env.TTML_CACHE.put(
    key,
    JSON.stringify({ status: "pending", trackId } satisfies CacheEntry),
    { expirationTtl: asNumber(env.CACHE_TTL_SECONDS, 2592000) },
  );

  await env.ttml_queue.send({ jobId, trackId, audioUrl, lyrics, language } satisfies AlignMessage);

  return Response.json({ status: "queued", jobId: key } satisfies AlignResponse, { status: 202 });
}

// ─── Route: GET /status/:key ─────────────────────────────────────

async function handleStatus(key: string, env: Env): Promise<Response> {
  const cached = await env.TTML_CACHE.get<CacheEntry>(key, "json");

  if (!cached) {
    return Response.json({ status: "pending" } satisfies StatusResponse);
  }

  if (cached.status === "done") {
    return Response.json({ status: "done", ttmlUrl: cached.ttmlUrl } satisfies StatusResponse);
  }

  if (cached.status === "error") {
    return Response.json({ status: "error", error: cached.error } satisfies StatusResponse);
  }

  return Response.json({ status: "pending" } satisfies StatusResponse);
}

// ─── Queue consumer ──────────────────────────────────────────────

async function handleQueueMessage(msg: AlignMessage, env: Env): Promise<void> {
  const key = kvKey(msg.trackId, msg.lyrics);

  const audio = await fetchAudio(msg.audioUrl);

  const maxBytes = asNumber(env.AUDIO_MAX_SIZE_MB, 25) * 1024 * 1024;
  if (audio.byteLength > maxBytes) {
    throw new Error(`Audio exceeds ${env.AUDIO_MAX_SIZE_MB ?? "25"}MB limit`);
  }

  const whisperWords = await runWhisper(audio, msg.language, env);
  const groundTruth = parseLyrics(msg.lyrics);
  const aligned = forceAlign(whisperWords, groundTruth);

  const ttml = buildTTML(aligned, msg.language ?? "en");

  const ttmlKey = `ttml/${msg.trackId}.ttml`;
  await env.TTML_BUCKET.put(ttmlKey, ttml, {
    httpMetadata: {
      contentType: "application/ttml+xml",
      cacheControl: "public, max-age=2592000",
    },
  });

  await env.TTML_CACHE.put(
    key,
    JSON.stringify({
      status: "done",
      ttmlUrl: ttmlKey,
      trackId: msg.trackId,
      alignedAt: Math.floor(Date.now() / 1000),
    } satisfies CacheEntry),
    { expirationTtl: asNumber(env.CACHE_TTL_SECONDS, 2592000) },
  );
}

// ─── Worker entry points ─────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/align" && req.method === "POST") {
      const limited = await checkRateLimit(req, env);
      if (limited) return limited;

      const body = (await req.json()) as AlignRequest;
      if (url.searchParams.has("sync")) {
        const msg: AlignMessage = { jobId: makeJobId(), ...body };
        await handleQueueMessage(msg, env);
        return Response.json({ status: "done", ttmlUrl: `ttml/${body.trackId}.ttml` });
      }
      return handleAlign(body, env);
    }

    if (url.pathname.startsWith("/status/") && req.method === "GET") {
      const key = url.pathname.slice("/status/".length);
      return handleStatus(key, env);
    }

    if (url.pathname.startsWith("/ttml/") && req.method === "GET") {
      const trackId = url.pathname.slice("/ttml/".length);
      const obj = await env.TTML_BUCKET.get(`ttml/${trackId}.ttml`);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(await obj.text(), {
        headers: { "Content-Type": "application/ttml+xml" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  async queue(batch: MessageBatch<AlignMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await handleQueueMessage(msg.body, env);
        msg.ack();
      } catch (err) {
        const key = kvKey(msg.body.trackId, msg.body.lyrics);
        const error = err instanceof Error ? err.message : "Unknown error";
        await env.TTML_CACHE.put(
          key,
          JSON.stringify({ status: "error", trackId: msg.body.trackId, error } satisfies CacheEntry),
          { expirationTtl: asNumber(env.CACHE_TTL_SECONDS, 2592000) },
        );
        msg.retry({ delaySeconds: 10 });
      }
    }
  },
};
