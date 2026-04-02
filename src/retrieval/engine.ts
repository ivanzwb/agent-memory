import type { EmbeddingProvider, ResolvedConfig, ConversationRow, LongTermMemoryRow, KnowledgeChunkRow, AssembledContext, ContextSource } from '../types';
import type { SqliteStorage } from '../storage/sqlite';
import type { VectorIndex } from '../vector/hnsw';
import type { DecayManager } from '../decay/manager';
import { countTokens } from '../utils/tokens';

/**
 * Hybrid retrieval engine: keyword search on conversations + vector search on LTM + knowledge base.
 * Merges, ranks, and fills within token budget.
 */
export class RetrievalEngine {
  constructor(
    private config: ResolvedConfig,
    private storage: SqliteStorage,
    private vectorIndex: VectorIndex,
    private embedding: EmbeddingProvider,
    private decayManager: DecayManager,
  ) {}

  async assembleContext(query: string, tokenBudgetOverride?: Partial<import('../types').TokenBudgetConfig>): Promise<AssembledContext> {
    // Merge per-call override with global config
    const tb = tokenBudgetOverride
      ? { ...this.config.tokenBudget, ...tokenBudgetOverride }
      : this.config.tokenBudget;

    // Compute available budget
    const budget = tb.contextWindow - tb.systemPromptReserve - tb.outputReserve;

    // Phase 1: Parallel retrieval
    const [convResults, ltmResults, kbResults] = await Promise.all([
      this.searchConversations(query),
      this.searchLongTermMemory(query),
      this.searchKnowledge(query),
    ]);

    // Phase 2: Merge and rank
    const candidates = this.mergeAndRank(convResults, ltmResults, kbResults);

    // Phase 3: Token budget greedy fill
    return this.fillBudget(candidates, budget);
  }

  private searchConversations(query: string): Promise<RankedCandidate[]> {
    const messages = this.storage.getActiveMessages();
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

    const results: RankedCandidate[] = [];
    const now = Date.now();

    for (const msg of messages) {
      const contentLower = msg.content.toLowerCase();
      // Simple keyword matching score
      let matchCount = 0;
      for (const term of queryTerms) {
        if (contentLower.includes(term)) matchCount++;
      }
      if (matchCount === 0 && queryTerms.length > 0) continue;

      const relevance = queryTerms.length > 0 ? matchCount / queryTerms.length : 0.3;
      const ageMs = now - msg.created_at;
      const recency = Math.exp(-ageMs / (24 * 3600 * 1000)); // decay over 1 day

      results.push({
        type: 'conversation' as const,
        id: msg.id,
        text: `[${this.roleLabel(msg.role)}] ${msg.content}`,
        relevance,
        recency,
        importance: msg.importance,
        tokenCount: msg.token_count,
      });
    }

    return Promise.resolve(results);
  }

  private async searchLongTermMemory(query: string): Promise<RankedCandidate[]> {
    const queryVector = await this.embedding.embed(query);
    const searchResults = this.vectorIndex.search(queryVector, 20);

    const results: RankedCandidate[] = [];
    for (const { id, score } of searchResults) {
      const row = this.storage.getLongTermMemory(id);
      if (!row || row.is_active !== 1) continue;

      const decay = this.decayManager.decayFactor(row.created_at, row.last_accessed);
      const importanceScore = row.confidence * (1 + Math.log1p(row.access_count));

      results.push({
        type: 'memory' as const,
        id: row.id,
        text: `[${this.categoryLabel(row.category)}] ${row.value}`,
        relevance: score,
        recency: decay,
        importance: importanceScore,
        tokenCount: countTokens(row.value),
      });
    }

    return results;
  }

  private async searchKnowledge(query: string): Promise<RankedCandidate[]> {
    const kbIds = new Set(this.storage.getAllKnowledgeIds());
    if (kbIds.size === 0) return [];

    const queryVector = await this.embedding.embed(query);
    const searchResults = this.vectorIndex.search(queryVector, 20);

    const results: RankedCandidate[] = [];
    for (const { id, score } of searchResults) {
      if (!kbIds.has(id)) continue;
      const row = this.storage.getKnowledgeChunk(id);
      if (!row) continue;

      // Only inject title + brief excerpt + reference ID — not full content.
      // LLM can call knowledge_read(id) tool to fetch the full document.
      const excerpt = row.content.length > 120
        ? row.content.slice(0, 120) + '…'
        : row.content;
      const refText = `[知识库·${row.source}] ${row.title} — ${excerpt} (ref:${row.id})`;

      results.push({
        type: 'knowledge' as const,
        id: row.id,
        text: refText,
        relevance: score,
        recency: 1.0, // knowledge doesn't decay
        importance: 0.8, // curated content has baseline importance
        tokenCount: countTokens(refText),
      });
    }
    return results;
  }

  private mergeAndRank(conv: RankedCandidate[], ltm: RankedCandidate[], kb: RankedCandidate[]): RankedCandidate[] {
    const all = [...conv, ...ltm, ...kb];

    // Composite score
    all.sort((a, b) => {
      const scoreA = this.compositeScore(a);
      const scoreB = this.compositeScore(b);
      return scoreB - scoreA;
    });

    return all;
  }

  private compositeScore(c: RankedCandidate): number {
    // Weighted combination: relevance dominates, recency and importance as tiebreakers
    return c.relevance * 0.6 + c.recency * 0.25 + Math.min(c.importance, 1) * 0.15;
  }

  private fillBudget(candidates: RankedCandidate[], budgetTokens: number): AssembledContext {
    const sources: ContextSource[] = [];
    const parts: string[] = [];
    let usedTokens = 0;

    // Reserve some budget for the MEMORY tags
    const overheadTokens = 10;
    const available = budgetTokens - overheadTokens;

    for (const c of candidates) {
      if (usedTokens + c.tokenCount > available) {
        // Try a truncated version if it's long
        if (c.tokenCount > 100) {
          const halfBudget = Math.floor((available - usedTokens) * 4); // approx chars
          if (halfBudget > 50) {
            const truncated = c.text.slice(0, halfBudget) + '…';
            const truncTokens = countTokens(truncated);
            if (usedTokens + truncTokens <= available) {
              parts.push(truncated);
              usedTokens += truncTokens;
              sources.push({ type: c.type, id: c.id, score: c.relevance });
              continue;
            }
          }
        }
        continue;
      }

      parts.push(c.text);
      usedTokens += c.tokenCount;
      sources.push({ type: c.type, id: c.id, score: c.relevance });
    }

    const text = parts.length > 0 ? `<MEMORY>\n${parts.join('\n')}\n</MEMORY>` : '';
    const tokenCount = text ? countTokens(text) : 0;

    return { text, tokenCount, sources };
  }

  private roleLabel(role: string): string {
    switch (role) {
      case 'user': return '对话历史';
      case 'assistant': return '对话历史';
      case 'system': return '系统';
      default: return '对话历史';
    }
  }

  private categoryLabel(category: string): string {
    switch (category) {
      case 'preference': return '偏好';
      case 'fact': return '事实';
      case 'episodic': return '摘要';
      case 'procedural': return '程序';
      default: return '记忆';
    }
  }
}

interface RankedCandidate {
  type: 'conversation' | 'memory' | 'knowledge';
  id: string | number;
  text: string;
  relevance: number;
  recency: number;
  importance: number;
  tokenCount: number;
}
