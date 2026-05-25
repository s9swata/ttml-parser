export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignedWord {
  word: string;
  start: number;
  end: number;
  confidence: "exact" | "interpolated";
}

export interface CacheEntry {
  status: "pending" | "done" | "error";
  ttmlUrl?: string;
  error?: string;
  trackId: string;
  alignedAt?: number;
}

export interface AlignRequest {
  trackId: string;
  audioUrl: string;
  lyrics: string;
  language?: string;
}

export interface AlignResponse {
  status: "cached" | "queued";
  ttmlUrl?: string;
  jobId?: string;
}

export interface StatusResponse {
  status: "pending" | "done" | "error";
  ttmlUrl?: string;
  error?: string;
}

export interface AlignMessage {
  jobId: string;
  trackId: string;
  audioUrl: string;
  lyrics: string;
  language?: string;
}

export interface Env {
  ttml_queue: Queue<AlignMessage>;
  TTML_CACHE: KVNamespace;
  TTML_BUCKET: R2Bucket;
  GROQ_API_KEY: string;
  AUDIO_MAX_SIZE_MB?: string;
  CACHE_TTL_SECONDS?: string;
  RATE_LIMIT_PER_MINUTE?: string;
}
