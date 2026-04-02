/** Max length for a single memory value before truncation */
const MAX_VALUE_LENGTH = 10000;

/** Patterns that look like secrets / credentials */
const SENSITIVE_PATTERNS = [
  /\b(?:sk|pk|api[_-]?key|secret|token|password|passwd|bearer)\s*[:=]\s*\S{8,}/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // Base64-ish long strings
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
];

/** Prompt injection markers to strip */
const INJECTION_PATTERNS = [
  /<\/?(?:system|instruction|prompt|ignore)[^>]*>/gi,
  /\[(?:SYSTEM|INST(?:RUCTION)?)\]/gi,
];

/**
 * Sanitize text before writing to memory.
 * - Strips prompt injection markers
 * - Detects and redacts sensitive strings
 * - Truncates overly long content
 *
 * Returns { text, warnings } where warnings describe any modifications made.
 */
export function sanitize(text: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let cleaned = text;

  // Strip injection markers
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      warnings.push('Stripped potential prompt injection markers');
      cleaned = cleaned.replace(pattern, '');
    }
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
  }

  // Redact sensitive content
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(cleaned)) {
      warnings.push('Redacted potential sensitive information');
      cleaned = cleaned.replace(pattern, '[REDACTED]');
    }
    pattern.lastIndex = 0;
  }

  // Strip null bytes and other control chars (keep newlines/tabs)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Truncate
  if (cleaned.length > MAX_VALUE_LENGTH) {
    warnings.push(`Truncated from ${cleaned.length} to ${MAX_VALUE_LENGTH} characters`);
    cleaned = cleaned.slice(0, MAX_VALUE_LENGTH);
  }

  return { text: cleaned, warnings };
}
