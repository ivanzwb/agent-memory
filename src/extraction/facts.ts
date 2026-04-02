import type { LLMProvider, MemoryCategory } from '../types';

/** Extracted fact ready for storage */
export interface ExtractedFact {
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
}

// ------- Rule-based patterns -------

interface ExtractionRule {
  pattern: RegExp;
  category: MemoryCategory;
  keyExtractor: (match: RegExpMatchArray) => string;
  valueExtractor: (match: RegExpMatchArray) => string;
  confidence: number;
}

const RULES: ExtractionRule[] = [
  // "I like / prefer / favor X"
  {
    pattern: /(?:i\s+(?:like|prefer|favor|love|enjoy|use|want))\s+(.+?)(?:\.|$)/gi,
    category: 'preference',
    keyExtractor: (m) => `prefers_${m[1].trim().slice(0, 30).replace(/\s+/g, '_').toLowerCase()}`,
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.8,
  },
  // "我喜欢/偏好/习惯 X"
  {
    pattern: /(?:我(?:喜欢|偏好|习惯|倾向|爱用))\s*(.+?)(?:[。，.,$]|$)/gi,
    category: 'preference',
    keyExtractor: (m) => `prefers_${m[1].trim().slice(0, 30)}`,
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.8,
  },
  // "Don't / never use X"
  {
    pattern: /(?:don'?t|never|avoid|do not)\s+(?:use|like|want)\s+(.+?)(?:\.|$)/gi,
    category: 'preference',
    keyExtractor: (m) => `avoids_${m[1].trim().slice(0, 30).replace(/\s+/g, '_').toLowerCase()}`,
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.8,
  },
  // "不要/别用 X"
  {
    pattern: /(?:不要|别用|不用|不喜欢)\s*(.+?)(?:[。，.,$]|$)/gi,
    category: 'preference',
    keyExtractor: (m) => `avoids_${m[1].trim().slice(0, 30)}`,
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.8,
  },
  // "The project uses / adopts X" or "项目使用/采用 X"
  {
    pattern: /(?:project|system|app|application|we)\s+(?:use[sd]?|adopt[sd]?|run[s]?)\s+(.+?)(?:\.|$)/gi,
    category: 'fact',
    keyExtractor: (m) => `uses_${m[1].trim().slice(0, 30).replace(/\s+/g, '_').toLowerCase()}`,
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.8,
  },
  {
    pattern: /(?:项目|系统|应用)(?:使用|采用|用的是)\s*(.+?)(?:[。，.,$]|$)/gi,
    category: 'fact',
    keyExtractor: (m) => `uses_${m[1].trim().slice(0, 30)}`,
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.8,
  },
  // "My name is X" / "I am X"
  {
    pattern: /(?:my name is|i'?m called|call me)\s+(.+?)(?:\.|$)/gi,
    category: 'fact',
    keyExtractor: () => 'user_name',
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.9,
  },
  // "我叫 X" / "我是 X"
  {
    pattern: /(?:我叫|我是|我的名字是)\s*(.+?)(?:[。，.,$]|$)/gi,
    category: 'fact',
    keyExtractor: () => 'user_name',
    valueExtractor: (m) => m[0].trim(),
    confidence: 0.9,
  },
];

/**
 * Extract facts from a conversation turn using rule-based pattern matching.
 */
export function extractByRules(userMessage: string, assistantReply: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const text = `${userMessage}\n${assistantReply}`;

  for (const rule of RULES) {
    // Reset lastIndex for global regexes
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      facts.push({
        category: rule.category,
        key: rule.keyExtractor(match),
        value: rule.valueExtractor(match),
        confidence: rule.confidence,
      });
    }
  }

  return dedup(facts);
}

/**
 * Extract facts using an injected LLM provider.
 * Returns empty array if LLM is not available.
 */
export async function extractByLLM(
  llm: LLMProvider | null,
  userMessage: string,
  assistantReply: string,
): Promise<ExtractedFact[]> {
  if (!llm) return [];

  const prompt = `Analyze the following conversation turn and extract any notable facts, user preferences, or important information worth remembering long-term.

User: ${userMessage}
Assistant: ${assistantReply}

Return a JSON array of objects with these fields:
- category: "preference" | "fact" | "episodic"
- key: a short identifier (snake_case)
- value: the fact/preference text

If nothing worth remembering, return an empty array [].
Return ONLY valid JSON, no other text.`;

  try {
    const response = await llm.generate(prompt);
    // Extract JSON from the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ category: string; key: string; value: string }>;
    return parsed
      .filter((item) => item.category && item.key && item.value)
      .map((item) => ({
        category: item.category as MemoryCategory,
        key: String(item.key),
        value: String(item.value),
        confidence: 0.6,
      }));
  } catch {
    // LLM extraction failure is non-fatal
    return [];
  }
}

function dedup(facts: ExtractedFact[]): ExtractedFact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const k = `${f.category}:${f.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
