// agent-memory — main entry point

export { AgentMemoryImpl } from './memory';

// Factory function (the primary public API)
import type { MemoryConfig, AgentMemory } from './types';
import { AgentMemoryImpl } from './memory';

/**
 * Create a new agent memory instance.
 * All config options are optional with sensible defaults.
 *
 * @example
 * ```ts
 * const memory = await createMemory();
 * await memory.appendMessage('user', 'Hello!');
 * const ctx = await memory.assembleContext('greeting');
 * await memory.close();
 * ```
 */
export async function createMemory(config?: MemoryConfig): Promise<AgentMemory> {
  return AgentMemoryImpl.create(config);
}

// Re-export all types
export type {
  AgentMemory,
  MemoryConfig,
  ResolvedConfig,
  EmbeddingProvider,
  LLMProvider,
  MessageRole,
  MemoryCategory,
  MemoryStatus,
  ToolFormat,
  Message,
  MemoryItem,
  ScoredMemoryItem,
  AssembledContext,
  ContextSource,
  KnowledgeChunk,
  ScoredKnowledgeChunk,
  MemoryFilter,
  MemoryStats,
  MaintenanceResult,
  ExportData,
  TokenBudgetConfig,
  ArchiveConfig,
  DecayConfig,
  LimitsConfig,
} from './types';

// Re-export errors
export {
  MemoryError,
  MemoryClosedError,
  MemoryNotFoundError,
  MemoryCapacityError,
  EmbeddingError,
} from './errors';
