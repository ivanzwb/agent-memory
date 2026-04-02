// ============================================================
// Core Types for agent-memory
// ============================================================

/** Role of a conversation message */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Category of a long-term memory item */
export type MemoryCategory = 'preference' | 'fact' | 'episodic' | 'procedural';

/** Status of a long-term memory */
export type MemoryStatus = 'active' | 'dormant' | 'deleted';

/** Supported LLM tool export formats */
export type ToolFormat = 'openai' | 'anthropic' | 'langchain';

// ============================================================
// Data Structures
// ============================================================

/** A conversation message (Layer 2) */
export interface Message {
  id: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  metadata?: Record<string, unknown>;
  createdAt: number; // Unix ms
}

/** A long-term memory item (Layer 3) */
export interface MemoryItem {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  accessCount: number;
  lastAccessed: number | null;
  isActive: boolean;
  createdAt: number; // Unix ms
}

/** A memory item returned from search, with relevance score */
export interface ScoredMemoryItem extends MemoryItem {
  score: number;
}

/** A pre-processed knowledge chunk (knowledge base entry) */
export interface KnowledgeChunk {
  id: string;
  source: string;
  title: string;
  content: string;
  tokenCount: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/** A knowledge chunk returned from search, with relevance score */
export interface ScoredKnowledgeChunk extends KnowledgeChunk {
  score: number;
}

/** Assembled context ready for prompt injection */
export interface AssembledContext {
  text: string;
  tokenCount: number;
  sources: ContextSource[];
}

/** A single source entry in assembled context */
export interface ContextSource {
  type: 'conversation' | 'memory' | 'knowledge';
  id: string | number;
  score: number;
}

// ============================================================
// Provider Interfaces
// ============================================================

/** Embedding provider — converts text to vectors */
export interface EmbeddingProvider {
  /** Vector dimensionality (e.g. 384, 768, 1536) */
  readonly dimensions: number;
  /** Embed a single text string into a vector */
  embed(text: string): Promise<number[]>;
}

/** LLM provider — used for archive summarization and fact extraction */
export interface LLMProvider {
  /** Generate text given a prompt */
  generate(prompt: string): Promise<string>;
}

// ============================================================
// Configuration
// ============================================================

export interface TokenBudgetConfig {
  /** Model context window size in tokens (default: 128000) */
  contextWindow?: number;
  /** Tokens reserved for system prompt (default: 2000) */
  systemPromptReserve?: number;
  /** Tokens reserved for LLM output (default: 1000) */
  outputReserve?: number;
}

export interface ArchiveConfig {
  /** Minutes of silence before archive runs (default: 5) */
  quietMinutes?: number;
  /** Only archive messages older than this many hours (default: 24) */
  windowHours?: number;
  /** Minimum messages to trigger archive (default: 5) */
  minBatch?: number;
  /** Max messages per archive batch (default: 20) */
  maxBatch?: number;
}

export interface DecayConfig {
  /** Days until a memory becomes dormant (default: 90) */
  dormantAfterDays?: number;
  /** Days until a dormant memory is candidate for deletion (default: 180) */
  expireAfterDays?: number;
}

export interface LimitsConfig {
  /** Max active conversation messages (default: 500) */
  maxConversationMessages?: number;
  /** Max long-term memory items (default: 1000) */
  maxLongTermMemories?: number;
}

export interface MemoryConfig {
  /** Data storage directory. Falls back to env var AGENT_MEMORY_DATA_DIR, then './agent-memory-data' */
  dataDir?: string;
  /** Custom embedding provider (default: built-in local model) */
  embedding?: EmbeddingProvider;
  /** LLM provider for summarization/extraction (default: none) */
  llm?: LLMProvider;
  /** Token budget settings */
  tokenBudget?: TokenBudgetConfig;
  /** Archive scheduler settings */
  archive?: ArchiveConfig;
  /** Decay/forgetting settings */
  decay?: DecayConfig;
  /** Capacity limits */
  limits?: LimitsConfig;
  /** Callback when a memory enters decay warning state */
  onDecayWarning?: (item: MemoryItem) => void;
}

/** Resolved config with all defaults applied */
export interface ResolvedConfig {
  dataDir: string;
  embedding: EmbeddingProvider;
  llm: LLMProvider | null;
  tokenBudget: Required<TokenBudgetConfig>;
  archive: Required<ArchiveConfig>;
  decay: Required<DecayConfig>;
  limits: Required<LimitsConfig>;
  onDecayWarning: ((item: MemoryItem) => void) | null;
}

// ============================================================
// Filter & Results
// ============================================================

export interface MemoryFilter {
  category?: MemoryCategory;
  isActive?: boolean;
  createdAfter?: number;
  createdBefore?: number;
}

export interface MemoryStats {
  conversation: {
    activeCount: number;
    archivedCount: number;
  };
  longTerm: {
    activeCount: number;
    dormantCount: number;
    deletedCount: number;
  };
  knowledge: {
    chunkCount: number;
    sourceCount: number;
  };
  storage: {
    sqliteBytes: number;
    vectorIndexBytes: number;
  };
}

export interface MaintenanceResult {
  archivedCount: number;
  dormantCount: number;
  summariesGenerated: number;
}

export interface ExportData {
  version: string;
  exportedAt: number;
  conversations: ConversationRow[];
  longTermMemories: LongTermMemoryRow[];
  knowledgeChunks: KnowledgeChunkRow[];
}

// ============================================================
// Internal DB Row Types
// ============================================================

export interface ConversationRow {
  id: number;
  role: string;
  content: string;
  token_count: number;
  attachments: string | null;
  related_task_id: string | null;
  metadata: string | null;
  summary: string | null;
  importance: number;
  is_archived: number;
  ltm_ref_id: string | null;
  created_at: number;
}

export interface LongTermMemoryRow {
  id: string;
  category: string;
  key: string;
  value: string;
  embedding_id: string;
  confidence: number;
  access_count: number;
  last_accessed: number | null;
  is_active: number;
  created_at: number;
}

export interface KnowledgeChunkRow {
  id: string;
  source: string;
  title: string;
  content: string;
  embedding_id: string;
  token_count: number;
  metadata: string | null;
  created_at: number;
}

// ============================================================
// The main AgentMemory interface
// ============================================================

export interface AgentMemory {
  // Read
  getConversationHistory(limit?: number): Promise<Message[]>;
  searchMemory(query: string, topK?: number): Promise<ScoredMemoryItem[]>;
  assembleContext(query: string, tokenBudget?: Partial<TokenBudgetConfig>): Promise<AssembledContext>;

  // Write
  appendMessage(role: MessageRole, content: string, metadata?: Record<string, unknown>): Promise<number>;
  saveMemory(category: MemoryCategory, key: string, value: string, confidence?: number): Promise<string>;

  // Knowledge Base
  addKnowledge(source: string, title: string, content: string, metadata?: Record<string, unknown>): Promise<string>;
  addKnowledgeBatch(chunks: Array<{ source: string; title: string; content: string; metadata?: Record<string, unknown> }>): Promise<string[]>;
  removeKnowledge(id: string): Promise<void>;
  removeKnowledgeBySource(source: string): Promise<number>;
  listKnowledge(source?: string): Promise<KnowledgeChunk[]>;
  searchKnowledge(query: string, topK?: number): Promise<ScoredKnowledgeChunk[]>;

  // Manage
  deleteMemory(id: string): Promise<void>;
  listMemories(filter?: MemoryFilter): Promise<MemoryItem[]>;
  refreshAccess(id: string): Promise<void>;

  // LLM Tool Integration
  getToolDefinitions(format: ToolFormat): unknown[];
  executeTool(name: string, args: Record<string, unknown>): Promise<unknown>;

  // Config
  updateTokenBudget(budget: Partial<TokenBudgetConfig>): void;

  // Ops
  getStats(): Promise<MemoryStats>;
  listConversations(offset?: number, limit?: number): Promise<Message[]>;
  runMaintenance(): Promise<MaintenanceResult>;
  export(): Promise<ExportData>;
  import(data: ExportData): Promise<void>;
  purge(): Promise<number>;
  close(): Promise<void>;
}
