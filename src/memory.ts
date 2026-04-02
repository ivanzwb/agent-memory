import type {
  AgentMemory,
  MemoryConfig,
  ResolvedConfig,
  EmbeddingProvider,
  TokenBudgetConfig,
  MessageRole,
  MemoryCategory,
  MemoryFilter,
  Message,
  MemoryItem,
  ScoredMemoryItem,
  KnowledgeChunk,
  ScoredKnowledgeChunk,
  AssembledContext,
  MemoryStats,
  MaintenanceResult,
  ExportData,
  ToolFormat,
  LongTermMemoryRow,
} from './types';
import { MemoryClosedError, MemoryNotFoundError, MemoryCapacityError } from './errors';
import { SqliteStorage } from './storage/sqlite';
import { VectorIndex } from './vector/hnsw';
import { LocalEmbeddingProvider } from './embedding/local';
import { RetrievalEngine } from './retrieval/engine';
import { ArchiveScheduler } from './archive/scheduler';
import { DecayManager } from './decay/manager';
import { AuditLogger } from './audit/logger';
import { KnowledgeBase } from './knowledge/base';
import { extractByRules, extractByLLM } from './extraction/facts';
import { getToolDefinitions, resolveToolCall } from './tools/definitions';
import { countTokens } from './utils/tokens';
import { generateMemoryId, generateEmbeddingId } from './utils/id';
import { sanitize } from './utils/sanitize';

const DEFAULTS: Omit<ResolvedConfig, 'embedding'> & { embedding: null } = {
  dataDir: process.env.AGENT_MEMORY_DATA_DIR || './agent-memory-data',
  embedding: null,
  llm: null,
  tokenBudget: {
    contextWindow: 128000,
    systemPromptReserve: 2000,
    outputReserve: 1000,
  },
  archive: {
    quietMinutes: 5,
    windowHours: 24,
    minBatch: 5,
    maxBatch: 20,
  },
  decay: {
    dormantAfterDays: 90,
    expireAfterDays: 180,
  },
  limits: {
    maxConversationMessages: 500,
    maxLongTermMemories: 1000,
  },
  onDecayWarning: null,
};

/**
 * Internal implementation of the AgentMemory interface.
 * Created via the `createMemory()` factory function.
 */
export class AgentMemoryImpl implements AgentMemory {
  private config: ResolvedConfig;
  private storage: SqliteStorage;
  private vectorIndex: VectorIndex;
  private retrieval: RetrievalEngine;
  private archiveScheduler: ArchiveScheduler;
  private decayManager: DecayManager;
  private knowledgeBase: KnowledgeBase;
  private audit: AuditLogger;
  private closed = false;

  private constructor(
    config: ResolvedConfig,
    storage: SqliteStorage,
    vectorIndex: VectorIndex,
    audit: AuditLogger,
  ) {
    this.config = config;
    this.storage = storage;
    this.vectorIndex = vectorIndex;
    this.audit = audit;

    this.decayManager = new DecayManager(config, storage);
    this.knowledgeBase = new KnowledgeBase(storage, vectorIndex, config.embedding, audit);
    this.retrieval = new RetrievalEngine(config, storage, vectorIndex, config.embedding, this.decayManager);
    this.archiveScheduler = new ArchiveScheduler(
      config,
      storage,
      (cat, key, value, confidence) => this.saveMemoryInternal(cat, key, value, confidence),
      audit,
    );
  }

  /**
   * Async factory: resolves config, initializes storage/vector index, returns ready instance.
   */
  static async create(userConfig?: MemoryConfig): Promise<AgentMemoryImpl> {
    const dataDir = userConfig?.dataDir ?? DEFAULTS.dataDir;
    const embedding: EmbeddingProvider =
      userConfig?.embedding ?? new LocalEmbeddingProvider(dataDir);

    const config: ResolvedConfig = {
      dataDir,
      embedding,
      llm: userConfig?.llm ?? DEFAULTS.llm,
      tokenBudget: { ...DEFAULTS.tokenBudget, ...userConfig?.tokenBudget },
      archive: { ...DEFAULTS.archive, ...userConfig?.archive },
      decay: { ...DEFAULTS.decay, ...userConfig?.decay },
      limits: { ...DEFAULTS.limits, ...userConfig?.limits },
      onDecayWarning: userConfig?.onDecayWarning ?? DEFAULTS.onDecayWarning,
    };

    const storage = new SqliteStorage(dataDir);
    const vectorIndex = new VectorIndex(dataDir, embedding.dimensions);
    await vectorIndex.initialize();
    const audit = new AuditLogger(dataDir);

    return new AgentMemoryImpl(config, storage, vectorIndex, audit);
  }

  // ============================================================
  //  Guard
  // ============================================================

  private ensureOpen(): void {
    if (this.closed) throw new MemoryClosedError();
  }

  // ============================================================
  //  Read
  // ============================================================

  async getConversationHistory(limit?: number): Promise<Message[]> {
    this.ensureOpen();
    const rows = this.storage.getActiveMessages(limit);
    return rows.map(rowToMessage);
  }

  async searchMemory(query: string, topK = 5): Promise<ScoredMemoryItem[]> {
    this.ensureOpen();
    const queryVector = await this.config.embedding.embed(query);
    const results = this.vectorIndex.search(queryVector, topK);

    const items: ScoredMemoryItem[] = [];
    for (const { id, score } of results) {
      const row = this.storage.getLongTermMemory(id);
      if (!row || row.is_active !== 1) continue;

      // Refresh access on hit
      this.storage.refreshAccess(id);

      items.push({
        ...rowToMemoryItem(row),
        score,
      });
    }
    return items;
  }

  async assembleContext(query: string, tokenBudget?: Partial<TokenBudgetConfig>): Promise<AssembledContext> {
    this.ensureOpen();
    // Lazily trigger archive check
    await this.archiveScheduler.tryArchive();
    return this.retrieval.assembleContext(query, tokenBudget);
  }

  // ============================================================
  //  Write
  // ============================================================

  async appendMessage(
    role: MessageRole,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<number> {
    this.ensureOpen();

    // Check capacity
    const activeCount = this.storage.countActiveMessages();
    if (activeCount >= this.config.limits.maxConversationMessages) {
      throw new MemoryCapacityError(
        'conversation messages',
        activeCount,
        this.config.limits.maxConversationMessages,
      );
    }

    const tokenCount = countTokens(content);
    const id = this.storage.insertMessage(role, content, tokenCount, metadata);

    this.audit.log({ action: 'append_message', targetId: id, details: role });

    // Async fact extraction (fire and forget)
    if (role === 'assistant') {
      this.tryExtractFacts(content).catch(() => {});
    }

    return id;
  }

  async saveMemory(
    category: MemoryCategory,
    key: string,
    value: string,
    confidence = 0.7,
  ): Promise<string> {
    this.ensureOpen();
    return this.saveMemoryInternal(category, key, value, confidence);
  }

  /** Internal save — also used by archive scheduler */
  private async saveMemoryInternal(
    category: MemoryCategory,
    key: string,
    value: string,
    confidence: number,
  ): Promise<string> {
    // Capacity check
    const counts = this.storage.countLongTermByStatus();
    if (counts.active >= this.config.limits.maxLongTermMemories) {
      throw new MemoryCapacityError(
        'long-term memories',
        counts.active,
        this.config.limits.maxLongTermMemories,
      );
    }

    // Sanitize
    const { text: cleanValue, warnings } = sanitize(value);
    if (warnings.length > 0) {
      this.audit.log({
        action: 'save_memory',
        details: `Sanitization: ${warnings.join('; ')}`,
      });
    }

    // Generate IDs
    const memoryId = generateMemoryId();
    const embeddingId = generateEmbeddingId();

    // Generate embedding vector
    const vector = await this.config.embedding.embed(cleanValue);

    // Atomic write: DB + vector index
    const row: LongTermMemoryRow = {
      id: memoryId,
      category,
      key,
      value: cleanValue,
      embedding_id: embeddingId,
      confidence,
      access_count: 0,
      last_accessed: null,
      is_active: 1,
      created_at: Date.now(),
    };
    this.storage.insertLongTermMemory(row);
    this.vectorIndex.add(memoryId, vector);

    this.audit.log({ action: 'save_memory', targetId: memoryId, details: `${category}:${key}` });

    return memoryId;
  }

  // ============================================================
  //  Knowledge Base
  // ============================================================

  async addKnowledge(
    source: string,
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.ensureOpen();
    return this.knowledgeBase.add(source, title, content, metadata);
  }

  async addKnowledgeBatch(
    chunks: Array<{ source: string; title: string; content: string; metadata?: Record<string, unknown> }>,
  ): Promise<string[]> {
    this.ensureOpen();
    return this.knowledgeBase.addBatch(chunks);
  }

  async removeKnowledge(id: string): Promise<void> {
    this.ensureOpen();
    this.knowledgeBase.remove(id);
  }

  async removeKnowledgeBySource(source: string): Promise<number> {
    this.ensureOpen();
    return this.knowledgeBase.removeBySource(source);
  }

  async listKnowledge(source?: string): Promise<KnowledgeChunk[]> {
    this.ensureOpen();
    return this.knowledgeBase.list(source);
  }

  async searchKnowledge(query: string, topK = 5): Promise<ScoredKnowledgeChunk[]> {
    this.ensureOpen();
    return this.knowledgeBase.search(query, topK);
  }

  // ============================================================
  //  Manage
  // ============================================================

  async deleteMemory(id: string): Promise<void> {
    this.ensureOpen();
    const row = this.storage.getLongTermMemory(id);
    if (!row) throw new MemoryNotFoundError(id);

    this.storage.softDeleteMemory(id);
    this.vectorIndex.remove(id);

    this.audit.log({ action: 'delete_memory', targetId: id });
  }

  async listMemories(filter?: MemoryFilter): Promise<MemoryItem[]> {
    this.ensureOpen();
    const rows = this.storage.listLongTermMemories(
      filter
        ? {
            category: filter.category,
            isActive: filter.isActive === undefined ? undefined : filter.isActive ? 1 : 0,
            createdAfter: filter.createdAfter,
            createdBefore: filter.createdBefore,
          }
        : undefined,
    );
    return rows.map(rowToMemoryItem);
  }

  async refreshAccess(id: string): Promise<void> {
    this.ensureOpen();
    const row = this.storage.getLongTermMemory(id);
    if (!row) throw new MemoryNotFoundError(id);
    this.storage.refreshAccess(id);
  }

  // ============================================================
  //  LLM Tool Integration
  // ============================================================

  getToolDefinitions(format: ToolFormat): unknown[] {
    this.ensureOpen();
    return getToolDefinitions(format);
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.ensureOpen();
    const spec = resolveToolCall(name);
    if (!spec) return { error: `Unknown tool: ${name}` };

    switch (name) {
      case 'memory_search':
        return this.searchMemory(
          String(args.query ?? ''),
          typeof args.topK === 'number' ? args.topK : 5,
        );
      case 'memory_save':
        return {
          id: await this.saveMemory(
            String(args.category) as MemoryCategory,
            String(args.key),
            String(args.value),
          ),
        };
      case 'memory_list':
        return this.listMemories(
          args.category ? { category: String(args.category) as MemoryCategory } : undefined,
        );
      case 'memory_delete':
        // Default: return confirmation prompt instead of deleting
        return {
          confirmation_required: true,
          message: `Are you sure you want to delete memory ${args.id}?`,
          confirm_action: { tool: 'memory_delete', args: { id: args.id, confirmed: true } },
        };
      case 'memory_get_history':
        return this.getConversationHistory(
          typeof args.limit === 'number' ? args.limit : 20,
        );
      case 'knowledge_read': {
        const row = this.storage.getKnowledgeChunk(String(args.id));
        if (!row) return { error: `Knowledge chunk not found: ${args.id}` };
        return {
          id: row.id,
          source: row.source,
          title: row.title,
          content: row.content,
          tokenCount: row.token_count,
        };
      }
      case 'knowledge_search': {
        const results = await this.searchKnowledge(
          String(args.query ?? ''),
          typeof args.topK === 'number' ? args.topK : 5,
        );
        // Return only titles + excerpts + IDs, not full content
        return results.map((r) => ({
          id: r.id,
          source: r.source,
          title: r.title,
          excerpt: r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content,
          score: r.score,
        }));
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ============================================================
  //  Config
  // ============================================================

  updateTokenBudget(budget: Partial<TokenBudgetConfig>): void {
    this.ensureOpen();
    if (budget.contextWindow !== undefined) {
      this.config.tokenBudget.contextWindow = budget.contextWindow;
    }
    if (budget.systemPromptReserve !== undefined) {
      this.config.tokenBudget.systemPromptReserve = budget.systemPromptReserve;
    }
    if (budget.outputReserve !== undefined) {
      this.config.tokenBudget.outputReserve = budget.outputReserve;
    }
  }

  // ============================================================
  //  Ops
  // ============================================================

  async getStats(): Promise<MemoryStats> {
    this.ensureOpen();
    const activeConv = this.storage.countActiveMessages();
    const archivedConv = this.storage.countArchivedMessages();
    const ltmCounts = this.storage.countLongTermByStatus();
    const sqliteBytes = this.storage.getDbSize();
    const vectorBytes = this.vectorIndex.getIndexFileSize();

    // Compute dormant count
    const dormantThresholdMs = this.config.decay.dormantAfterDays * 24 * 3600 * 1000;
    const dormantBefore = Date.now() - dormantThresholdMs;
    const dormantCandidates = this.storage.findDormantCandidates(dormantBefore);

    return {
      conversation: {
        activeCount: activeConv,
        archivedCount: archivedConv,
      },
      longTerm: {
        activeCount: ltmCounts.active - dormantCandidates.length,
        dormantCount: dormantCandidates.length,
        deletedCount: ltmCounts.deleted,
      },
      knowledge: {
        chunkCount: this.storage.countKnowledgeChunks(),
        sourceCount: this.storage.countKnowledgeSources(),
      },
      storage: {
        sqliteBytes,
        vectorIndexBytes: vectorBytes,
      },
    };
  }

  async listConversations(offset = 0, limit = 50): Promise<Message[]> {
    this.ensureOpen();
    const rows = this.storage.getAllMessages(offset, limit);
    return rows.map(rowToMessage);
  }

  async runMaintenance(): Promise<MaintenanceResult> {
    this.ensureOpen();
    this.audit.log({ action: 'maintenance' });

    // Run archive
    const archiveResult = await this.archiveScheduler.tryArchive();

    // Run decay check
    const dormantCount = this.decayManager.runDecayCheck();

    return {
      archivedCount: archiveResult.archivedCount,
      dormantCount,
      summariesGenerated: archiveResult.summariesGenerated,
    };
  }

  async export(): Promise<ExportData> {
    this.ensureOpen();
    const data = this.storage.exportAll();
    this.audit.log({ action: 'export' });
    return {
      version: '1.0.0',
      exportedAt: Date.now(),
      ...data,
    };
  }

  async import(data: ExportData): Promise<void> {
    this.ensureOpen();

    // Re-import DB rows
    this.storage.importAll(data.conversations, data.longTermMemories, data.knowledgeChunks || []);

    // Rebuild vector index from long-term memories
    for (const row of data.longTermMemories) {
      if (row.is_active === 1) {
        const vector = await this.config.embedding.embed(row.value);
        this.vectorIndex.add(row.id, vector);
      }
    }

    // Rebuild vector index from knowledge chunks
    if (data.knowledgeChunks) {
      for (const row of data.knowledgeChunks) {
        const vector = await this.config.embedding.embed(`${row.title}\n${row.content}`);
        this.vectorIndex.add(row.id, vector);
      }
    }

    this.audit.log({ action: 'import', details: `${data.longTermMemories.length} memories, ${(data.knowledgeChunks || []).length} KB chunks` });
  }

  async purge(): Promise<number> {
    this.ensureOpen();
    const count = this.storage.purgeDeleted();
    this.audit.log({ action: 'purge', details: `${count} records` });
    return count;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.vectorIndex.close();
    this.storage.close();
    this.audit.close();
  }

  // ============================================================
  //  Private helpers
  // ============================================================

  /**
   * Try to extract facts from the most recent conversation turn.
   */
  private async tryExtractFacts(assistantReply: string): Promise<void> {
    // Get the last user message
    const history = this.storage.getActiveMessages();
    if (history.length < 2) return;

    // Find last user message before this assistant reply
    let userMsg = '';
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        userMsg = history[i].content;
        break;
      }
    }
    if (!userMsg) return;

    // Rule-based extraction
    const ruleFacts = extractByRules(userMsg, assistantReply);

    // LLM-based extraction (if available)
    const llmFacts = await extractByLLM(this.config.llm, userMsg, assistantReply);

    // Merge, de-dup, and save
    const allFacts = [...ruleFacts, ...llmFacts];
    const seen = new Set<string>();

    for (const fact of allFacts) {
      const dedup = `${fact.category}:${fact.key}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      try {
        await this.saveMemoryInternal(fact.category, fact.key, fact.value, fact.confidence);
      } catch {
        // Non-fatal: capacity or embedding errors during extraction
      }
    }
  }
}

// ============================================================
//  Row → Domain converters
// ============================================================

function rowToMessage(row: {
  id: number;
  role: string;
  content: string;
  token_count: number;
  metadata: string | null;
  created_at: number;
}): Message {
  return {
    id: row.id,
    role: row.role as MessageRole,
    content: row.content,
    tokenCount: row.token_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  };
}

function rowToMemoryItem(row: LongTermMemoryRow): MemoryItem {
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}
