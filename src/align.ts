import { diffArrays } from "diff";
import { WhisperWord, AlignedWord } from "./types";

function normalize(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function parseLyrics(lyrics: string): string[] {
  return lyrics.trim().split(/\s+/).filter(Boolean);
}

interface Anchor {
  truthIdx: number;
  start: number;
  end: number;
}

export function forceAlign(
  whisperWords: WhisperWord[],
  groundTruth: string[],
): AlignedWord[] {
  if (groundTruth.length === 0) return [];

  const normalizedWhisper = whisperWords.map((w) => normalize(w.word));
  const normalizedTruth = groundTruth.map((w) => normalize(w));

  const changes = diffArrays(normalizedWhisper, normalizedTruth);

  const anchors: Anchor[] = [];
  let wi = 0;
  let ti = 0;

  for (const change of changes) {
    const len = change.count ?? change.value.length;

    if (change.added && change.removed) {
      for (let i = 0; i < len; i++) {
        if (wi < whisperWords.length) {
          anchors.push({
            truthIdx: ti + i,
            start: whisperWords[wi].start,
            end: whisperWords[wi].end,
          });
        }
        wi++;
        ti++;
      }
    } else if (change.added) {
      ti += len;
    } else if (change.removed) {
      wi += len;
    } else {
      for (let i = 0; i < len; i++) {
        if (wi + i < whisperWords.length) {
          anchors.push({
            truthIdx: ti + i,
            start: whisperWords[wi + i].start,
            end: whisperWords[wi + i].end,
          });
        }
      }
      wi += len;
      ti += len;
    }
  }

  const result: AlignedWord[] = [];
  let ai = 0;

  for (let t = 0; t < groundTruth.length; t++) {
    if (ai < anchors.length && anchors[ai].truthIdx === t) {
      result.push({
        word: groundTruth[t],
        start: anchors[ai].start,
        end: anchors[ai].end,
        confidence: "exact",
      });
      ai++;
    } else {
      const prev = ai > 0 ? anchors[ai - 1] : null;
      const next = ai < anchors.length ? anchors[ai] : null;

      let start: number;
      let end: number;

      if (prev && next) {
        const gap = next.truthIdx - prev.truthIdx;
        const offset = t - prev.truthIdx;
        const duration = next.start - prev.end;
        const segStart = duration * (offset / gap);
        const segEnd = duration * ((offset + 1) / gap);
        start = prev.end + segStart;
        end = prev.end + segEnd;
      } else if (prev) {
        const dur = (prev.end - prev.start) * 0.5;
        start = prev.end;
        end = start + dur;
      } else if (next) {
        const dur = (next.end - next.start) * 0.5;
        start = Math.max(0, next.start - dur);
        end = next.start;
      } else {
        start = 0;
        end = 0;
      }

      result.push({
        word: groundTruth[t],
        start,
        end,
        confidence: "interpolated",
      });
    }
  }

  return result;
}
