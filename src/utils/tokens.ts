/**
 * Lightweight token counting approximation.
 * Uses the ~4 chars per token heuristic for English text.
 * For CJK characters, each character counts as ~1.5 tokens.
 */
export function countTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    // CJK Unified Ideographs and common CJK ranges
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat
      (code >= 0x3000 && code <= 0x303f) || // CJK Punctuation
      (code >= 0xff00 && code <= 0xffef)    // Fullwidth forms
    ) {
      count += 1.5;
    } else {
      count += 0.25; // ~4 chars per token for Latin
    }
  }
  return Math.ceil(count);
}
