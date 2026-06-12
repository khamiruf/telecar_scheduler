// Extracts a parking level ("4A", "B2", "P3", "12") from free text —
// typed messages or Whisper transcripts of voice notes.

const NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};

// Whisper often spells single letters out ("bee", "ay") in voice transcripts.
const LETTER_WORDS: Record<string, string> = {
  ay: "a",
  bee: "b",
  cee: "c",
  see: "c",
  dee: "d",
};

const LEVEL_TOKEN = /^(?:[a-z]\d{1,2}|\d{1,2}[a-z]|\d{1,2}|[a-z]\d{1,2}[a-z])$/;
const KEYWORDS = new Set(["level", "floor", "lvl", "parking", "basement", "deck", "at", "on"]);
const TIME_SUFFIXES = new Set(["am", "pm", "oclock", "o'clock", "minutes", "min", "hours"]);

export function parseLevel(raw: string): string | null {
  const words = raw
    .toLowerCase()
    .replace(/[.,!?;:]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? LETTER_WORDS[w] ?? w);

  // Merge split tokens: "b 2" -> "b2", "4 a" -> "4a".
  const tokens: string[] = [];
  for (const word of words) {
    const prev = tokens[tokens.length - 1];
    if (
      prev !== undefined &&
      ((/^[a-z]$/.test(prev) && /^\d{1,2}$/.test(word)) ||
        (/^\d{1,2}$/.test(prev) && /^[a-z]$/.test(word)))
    ) {
      tokens[tokens.length - 1] = prev + word;
      continue;
    }
    tokens.push(word);
  }

  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!LEVEL_TOKEN.test(token)) continue;
    const next = tokens[i + 1];
    if (next !== undefined && TIME_SUFFIXES.has(next)) continue; // "at 5 pm" is a time, not a level
    const hasKeywordBefore = i > 0 && KEYWORDS.has(tokens[i - 1]);
    const isWholeMessage = tokens.length <= 2;
    const hasLetter = /[a-z]/.test(token);
    if (hasKeywordBefore || isWholeMessage || hasLetter) {
      candidates.push(token);
    }
  }

  if (candidates.length === 0) return null;
  // Prefer the last candidate: "moved it from 3A to level 5B" -> "5B".
  return candidates[candidates.length - 1].toUpperCase();
}
