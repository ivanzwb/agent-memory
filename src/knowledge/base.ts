import type { EmbeddingProvider, KnowledgeChunk, ScoredKnowledgeChunk, KnowledgeChunkRow } from '../types';
import type { SqliteStorage } from '../storage/sqlite';
import type { VectorIndex } from '../vector/hnsw';
import type { AuditLogger } from '../audit/logger';
import { countTokens } from '../utils/tokens';
import { sanitize } from '../utils/sanitize';
import * as crypto from 'crypto';

/**
 * Knowledge Base manager — handles pre-processed reference data (documents, FAQs, etc.)
 * that agents can draw upon during retrieval.
 *
 * Knowledge is distinct from long-term memory:
 * - Memory is learned from conversations (dynamic, evolving)
 * - Knowledge is pre-loaded reference material (static, curated by the developer)
 */
export class KnowledgeBase {
  constructor(
    private storage: SqliteStorage,
    private vectorIndex: VectorIndex,
    private embedding: EmbeddingProvider,
    private audit: AuditLogger,
  ) {}

  /**
   * Add a single knowledge chunk. Returns the chunk ID.
   */
  async add(
    source: string,
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const { text: cleanContent, warnings } = sanitize(content);
    if (warnings.length > 0) {
      this.audit.log({
        action: 'save_memory',
        details: `KB sanitization: ${warnings.join('; ')}`,
      });
    }

    const id = generateKbId();
    const embeddingId = `kb_${id}`;
    const tokenCount = countTokens(cleanContent);

    // Generate embedding
    const vector = await this.embedding.embed(`${title}\n${cleanContent}`);

    // Write to DB
    const row: KnowledgeChunkRow = {
      id,
      source,
      title,
      content: cleanContent,
      embedding_id: embeddingId,
      token_count: tokenCount,
      metadata: metadata ? JSON.stringify(metadata) : null,
      created_at: Date.now(),
    };
    this.storage.insertKnowledgeChunk(row);

    // Write to vector index
    this.vectorIndex.add(id, vector);

    this.audit.log({ action: 'save_memory', targetId: id, details: `knowledge:${source}/${title}` });

    return id;
  }

  /**
   * Add multiple chunks in batch. Returns array of IDs.
   */
  async addBatch(
    chunks: Array<{ source: string; title: string; content: string; metadata?: Record<string, unknown> }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const chunk of chunks) {
      const id = await this.add(chunk.source, chunk.title, chunk.content, chunk.metadata);
      ids.push(id);
    }
    return ids;
  }

  /**
   * Remove a single knowledge chunk by ID.
   */
  remove(id: string): void {
    const embeddingId = this.storage.deleteKnowledgeChunk(id);
    if (embeddingId) {
      this.vectorIndex.remove(id);
      this.audit.log({ action: 'delete_memory', targetId: id, details: 'knowledge' });
    }
  }

  /**
   * Remove all chunks from a given source. Returns count removed.
   */
  removeBySource(source: string): number {
    const rows = this.storage.deleteKnowledgeBySource(source);
    for (const row of rows) {
      this.vectorIndex.remove(row.id);
    }
    if (rows.length > 0) {
      this.audit.log({ action: 'delete_memory', details: `knowledge source "${source}": ${rows.length} chunks` });
    }
    return rows.length;
  }

  /**
   * List knowledge chunks, optionally filtered by source.
   */
  list(source?: string): KnowledgeChunk[] {
    const rows = this.storage.listKnowledgeChunks(source);
    return rows.map(rowToKnowledgeChunk);
  }

  /**
   * Semantic search over knowledge base.
   */
  async search(query: string, topK = 5): Promise<ScoredKnowledgeChunk[]> {
    const queryVector = await this.embedding.embed(query);
    const results = this.vectorIndex.search(queryVector, topK + 20); // over-fetch, filter to KB

    const items: ScoredKnowledgeChunk[] = [];
    for (const { id, score } of results) {
      const row = this.storage.getKnowledgeChunk(id);
      if (!row) continue; // not a KB chunk (might be an LTM vector)

      items.push({
        ...rowToKnowledgeChunk(row),
        score,
      });

      if (items.length >= topK) break;
    }
    return items;
  }

  /**
   * Get all KB chunk IDs (for vector search filtering).
   */
  getAllIds(): Set<string> {
    return new Set(this.storage.getAllKnowledgeIds());
  }
}

function generateKbId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(3).toString('hex');
  return `kb_${ts}_${rand}`;
}

function rowToKnowledgeChunk(row: KnowledgeChunkRow): KnowledgeChunk {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    content: row.content,
    tokenCount: row.token_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  };
}
