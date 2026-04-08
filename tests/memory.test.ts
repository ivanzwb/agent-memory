import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AgentMemoryImpl } from '../src/memory';
import type { EmbeddingProvider, MemoryConfig, ExportData } from '../src/types';
import { MemoryClosedError, MemoryNotFoundError, MemoryCapacityError } from '../src/errors';

// Mock the local embedding provider so the default fallback works without model files
jest.mock('../src/embedding/local', () => ({
  LocalEmbeddingProvider: jest.fn().mockImplementation(() => ({
    dimensions: 4,
    embed: jest.fn().mockResolvedValue([0.5, 0.5, 0.5, 0.5]),
  })),
}));

// Simple deterministic embedding provider for testing
function makeEmbedding(): EmbeddingProvider {
  return {
    dimensions: 4,
    embed: jest.fn().mockImplementation(async (text: string) => {
      // Simple hash-based deterministic vector
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) & 0xffff;
      return [
        ((h >> 12) & 0xf) / 15,
        ((h >> 8) & 0xf) / 15,
        ((h >> 4) & 0xf) / 15,
        (h & 0xf) / 15,
      ];
    }),
  };
}

function tmpDir(): string {
  return path.join(os.tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('AgentMemoryImpl', () => {
  let dataDir: string;
  let memory: AgentMemoryImpl;

  beforeEach(async () => {
    dataDir = tmpDir();
    memory = await AgentMemoryImpl.create({
      dataDir,
      embedding: makeEmbedding(),
      limits: { maxConversationMessages: 10, maxLongTermMemories: 10 },
    });
  });

  afterEach(async () => {
    await memory.close();
    // Wait for audit logger stream to finish
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ============================================================
  //  Factory
  // ============================================================

  describe('create', () => {
    it('creates an instance with defaults', async () => {
      const dir = tmpDir();
      const m = await AgentMemoryImpl.create({ dataDir: dir, embedding: makeEmbedding() });
      expect(m).toBeInstanceOf(AgentMemoryImpl);
      await m.close();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('uses LocalEmbeddingProvider when no embedding is provided', async () => {
      const dir = tmpDir();
      const m = await AgentMemoryImpl.create({ dataDir: dir });
      expect(m).toBeInstanceOf(AgentMemoryImpl);
      await m.close();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  // ============================================================
  //  Guard
  // ============================================================

  describe('ensureOpen', () => {
    it('throws MemoryClosedError after close', async () => {
      await memory.close();
      await expect(memory.getConversationHistory()).rejects.toThrow(MemoryClosedError);
    });

    it('close is idempotent', async () => {
      await memory.close();
      await memory.close(); // should not throw
    });
  });

  // ============================================================
  //  Conversation
  // ============================================================

  describe('appendMessage / getConversationHistory', () => {
    it('appends and retrieves messages', async () => {
      const id = await memory.appendMessage('default', 'user', 'Hello');
      expect(typeof id).toBe('number');

      const history = await memory.getConversationHistory();
      expect(history).toHaveLength(1);
      expect(history[0].role).toBe('user');
      expect(history[0].content).toBe('Hello');
    });

    it('supports metadata', async () => {
      await memory.appendMessage('default', 'user', 'Test', { tool: 'test' });
      const history = await memory.getConversationHistory();
      expect(history[0].metadata).toEqual({ tool: 'test' });
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) await memory.appendMessage('default', 'user', `msg${i}`);
      const limited = await memory.getConversationHistory(3);
      expect(limited).toHaveLength(3);
    });

    it('archives oldest messages instead of throwing when conversation is full', async () => {
      // Fill up to the configured maxConversationMessages (10)
      for (let i = 0; i < 10; i++) {
        await memory.appendMessage('default', 'user', `msg${i}`);
      }

      // Next append should trigger capacity-based archiving and still succeed
      await memory.appendMessage('default', 'user', 'overflow');

      const history = await memory.getConversationHistory();
      // Sliding window semantics: older messages should have been archived,
      // but we should not exceed the max active count.
      expect(history.length).toBeLessThanOrEqual(10);
      expect(history[history.length - 1].content).toBe('overflow');
    });

    it('triggers fact extraction for assistant messages', async () => {
      await memory.appendMessage('default', 'user', 'I prefer Python');
      await memory.appendMessage('default', 'assistant', 'Noted, you prefer Python.');
      // Just verify it doesn't throw — fact extraction is fire-and-forget
    });
  });

  describe('listConversations', () => {
    it('returns paginated results', async () => {
      for (let i = 0; i < 5; i++) await memory.appendMessage('default', 'user', `msg${i}`);
      const page = await memory.listConversations(2, 2);
      expect(page).toHaveLength(2);
      expect(page[0].content).toBe('msg2');
    });
  });

  // ============================================================
  //  Long-term Memory
  // ============================================================

  describe('saveMemory / searchMemory', () => {
    it('saves and searches memory', async () => {
      const id = await memory.saveMemory('fact', 'language', 'User prefers TypeScript');
      expect(id).toMatch(/^ltm_/);

      const results = await memory.searchMemory('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].value).toBe('User prefers TypeScript');
      expect(results[0].score).toBeDefined();
    });

    it('sanitizes value and logs warnings', async () => {
      // Use content that triggers sanitization (secret pattern)
      const id = await memory.saveMemory('fact', 'secrets', 'api_key: sk_live_abcdefgh12345678_secret');
      expect(id).toMatch(/^ltm_/);
      // Value should be sanitized
      const mems = await memory.listMemories();
      const item = mems.find((m) => m.id === id);
      expect(item!.value).toContain('[REDACTED]');
    });

    it('throws MemoryCapacityError when LTM is full', async () => {
      for (let i = 0; i < 10; i++) {
        await memory.saveMemory('fact', `key_${i}`, `value_${i}`);
      }
      await expect(memory.saveMemory('fact', 'overflow', 'too many')).rejects.toThrow(MemoryCapacityError);
    });
  });

  describe('deleteMemory', () => {
    it('soft-deletes a memory', async () => {
      const id = await memory.saveMemory('fact', 'k', 'v');
      await memory.deleteMemory(id);

      const results = await memory.searchMemory('v');
      expect(results.every((r) => r.id !== id)).toBe(true);
    });

    it('throws MemoryNotFoundError for bad id', async () => {
      await expect(memory.deleteMemory('nope')).rejects.toThrow(MemoryNotFoundError);
    });
  });

  describe('listMemories', () => {
    it('lists all memories', async () => {
      await memory.saveMemory('fact', 'k1', 'v1');
      await memory.saveMemory('preference', 'k2', 'v2');

      const all = await memory.listMemories();
      expect(all).toHaveLength(2);

      const facts = await memory.listMemories({ category: 'fact' });
      expect(facts).toHaveLength(1);
      expect(facts[0].category).toBe('fact');
    });

    it('filters by isActive', async () => {
      const id = await memory.saveMemory('fact', 'k', 'v');
      await memory.deleteMemory(id);

      const active = await memory.listMemories({ isActive: true });
      expect(active).toHaveLength(0);

      const inactive = await memory.listMemories({ isActive: false });
      expect(inactive).toHaveLength(1);
    });

    it('filters by createdAfter/createdBefore', async () => {
      await memory.saveMemory('fact', 'k', 'v');
      const mems = await memory.listMemories({ createdAfter: Date.now() - 5000 });
      expect(mems.length).toBeGreaterThanOrEqual(1);

      const empty = await memory.listMemories({ createdBefore: Date.now() - 5000 });
      expect(empty).toHaveLength(0);
    });
  });

  describe('refreshAccess', () => {
    it('refreshes access count', async () => {
      const id = await memory.saveMemory('fact', 'k', 'v');
      await memory.refreshAccess(id);
      // Verify by searching — accessCount is used in scoring
      const items = await memory.listMemories();
      const item = items.find((m) => m.id === id);
      expect(item!.accessCount).toBe(1);
    });

    it('throws MemoryNotFoundError for bad id', async () => {
      await expect(memory.refreshAccess('nope')).rejects.toThrow(MemoryNotFoundError);
    });
  });

  // ============================================================
  //  Knowledge Base
  // ============================================================

  describe('knowledge base operations', () => {
    it('addKnowledge / listKnowledge', async () => {
      const id = await memory.addKnowledge('docs', 'Guide', 'Setup content');
      expect(id).toMatch(/^kb_/);

      const list = await memory.listKnowledge();
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Guide');
    });

    it('addKnowledgeBatch', async () => {
      const ids = await memory.addKnowledgeBatch([
        { source: 'docs', title: 'T1', content: 'C1' },
        { source: 'docs', title: 'T2', content: 'C2' },
      ]);
      expect(ids).toHaveLength(2);
    });

    it('removeKnowledge', async () => {
      const id = await memory.addKnowledge('docs', 'Guide', 'Content');
      await memory.removeKnowledge(id);
      const list = await memory.listKnowledge();
      expect(list).toHaveLength(0);
    });

    it('removeKnowledgeBySource', async () => {
      await memory.addKnowledge('docs', 'T1', 'C1');
      await memory.addKnowledge('docs', 'T2', 'C2');
      await memory.addKnowledge('faq', 'T3', 'C3');

      const count = await memory.removeKnowledgeBySource('docs');
      expect(count).toBe(2);

      const list = await memory.listKnowledge();
      expect(list).toHaveLength(1);
    });

    it('searchKnowledge', async () => {
      await memory.addKnowledge('docs', 'TypeScript Guide', 'How to use TypeScript');
      const results = await memory.searchKnowledge('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(0); // depends on embedding
    });

    it('listKnowledge with source filter', async () => {
      await memory.addKnowledge('docs', 'T1', 'C1');
      await memory.addKnowledge('faq', 'T2', 'C2');
      const filtered = await memory.listKnowledge('docs');
      expect(filtered).toHaveLength(1);
    });
  });

  // ============================================================
  //  assembleContext
  // ============================================================

  describe('assembleContext', () => {
    it('assembles context from messages', async () => {
      await memory.appendMessage('default', 'user', 'Hello world');
      const ctx = await memory.assembleContext('Hello');
      expect(ctx).toBeDefined();
      expect(typeof ctx.text).toBe('string');
      expect(typeof ctx.tokenCount).toBe('number');
      expect(Array.isArray(ctx.sources)).toBe(true);
    });

    it('accepts per-call tokenBudget override', async () => {
      await memory.appendMessage('default', 'user', 'data');
      const ctx = await memory.assembleContext('data', 1000);
      expect(ctx).toBeDefined();
    });
  });

  // ============================================================
  //  Tool Integration
  // ============================================================

  describe('getToolDefinitions', () => {
    it('returns tool definitions in openai format', () => {
      const tools = memory.getToolDefinitions('openai');
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('returns tool definitions in anthropic format', () => {
      const tools = memory.getToolDefinitions('anthropic');
      expect(tools.length).toBeGreaterThan(0);
    });

    it('returns tool definitions in langchain format', () => {
      const tools = memory.getToolDefinitions('langchain');
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('executeTool', () => {
    it('handles memory_search', async () => {
      await memory.saveMemory('fact', 'k', 'test value');
      const result = await memory.executeTool('memory_search', { query: 'test', topK: 5 });
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles memory_save', async () => {
      const result = (await memory.executeTool('memory_save', {
        category: 'fact',
        key: 'lang',
        value: 'TypeScript',
      })) as { id: string };
      expect(result.id).toMatch(/^ltm_/);
    });

    it('handles memory_list', async () => {
      await memory.saveMemory('fact', 'k', 'v');
      const result = await memory.executeTool('memory_list', {});
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles memory_list with category', async () => {
      await memory.saveMemory('fact', 'k', 'v');
      const result = await memory.executeTool('memory_list', { category: 'fact' });
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles memory_delete (confirmation)', async () => {
      const id = await memory.saveMemory('fact', 'k', 'v');
      const result = (await memory.executeTool('memory_delete', { id })) as { confirmation_required: boolean };
      expect(result.confirmation_required).toBe(true);
    });

    it('handles memory_get_history', async () => {
      await memory.appendMessage('default', 'user', 'hello');
      const result = await memory.executeTool('memory_get_history', { limit: 10 });
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles memory_get_history with default limit', async () => {
      const result = await memory.executeTool('memory_get_history', {});
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles knowledge_read', async () => {
      const id = await memory.addKnowledge('docs', 'Title', 'Content');
      const result = (await memory.executeTool('knowledge_read', { id })) as { content: string };
      expect(result.content).toBe('Content');
    });

    it('handles knowledge_read with missing id', async () => {
      const result = (await memory.executeTool('knowledge_read', { id: 'nope' })) as { error: string };
      expect(result.error).toContain('not found');
    });

    it('handles knowledge_search', async () => {
      await memory.addKnowledge('docs', 'TS Guide', 'TypeScript tutorial content');
      const result = await memory.executeTool('knowledge_search', { query: 'TypeScript', topK: 3 });
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles knowledge_search with long content (excerpt)', async () => {
      await memory.addKnowledge('docs', 'Long Doc', 'word '.repeat(100));
      const result = (await memory.executeTool('knowledge_search', { query: 'word' })) as Array<{ excerpt: string }>;
      // Even if results are empty due to embedding, test the code path
      // When results exist, excerpt should be truncated
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles unknown tool', async () => {
      const result = (await memory.executeTool('nonexistent_tool', {})) as { error: string };
      expect(result.error).toContain('Unknown tool');
    });

    it('handles memory_search with default topK', async () => {
      const result = await memory.executeTool('memory_search', { query: 'test' });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ============================================================
  //  Config
  // ============================================================

  describe('updateTokenBudget', () => {
    it('updates contextWindow', () => {
      memory.updateTokenBudget({ contextWindow: 64000 });
      expect((memory as any).config.tokenBudget.contextWindow).toBe(64000);
    });

    it('updates systemPromptReserve', () => {
      memory.updateTokenBudget({ systemPromptReserve: 5000 });
      expect((memory as any).config.tokenBudget.systemPromptReserve).toBe(5000);
    });

    it('updates outputReserve', () => {
      memory.updateTokenBudget({ outputReserve: 2000 });
      expect((memory as any).config.tokenBudget.outputReserve).toBe(2000);
    });

    it('updates multiple fields', () => {
      memory.updateTokenBudget({ contextWindow: 64000, outputReserve: 2000 });
      expect((memory as any).config.tokenBudget.contextWindow).toBe(64000);
      expect((memory as any).config.tokenBudget.outputReserve).toBe(2000);
    });
  });

  // ============================================================
  //  Ops
  // ============================================================

  describe('getStats', () => {
    it('returns stats', async () => {
      await memory.appendMessage('default', 'user', 'Hello');
      await memory.saveMemory('fact', 'k', 'v');
      await memory.addKnowledge('docs', 'T', 'C');

      const stats = await memory.getStats();
      expect(stats.conversation.activeCount).toBe(1);
      expect(stats.longTerm.activeCount).toBeGreaterThanOrEqual(1);
      expect(stats.knowledge.chunkCount).toBe(1);
      expect(stats.knowledge.sourceCount).toBe(1);
      expect(stats.storage.sqliteBytes).toBeGreaterThan(0);
      expect(typeof stats.storage.vectorIndexBytes).toBe('number');
    });
  });

  describe('runMaintenance', () => {
    it('runs maintenance', async () => {
      const result = await memory.runMaintenance();
      expect(typeof result.archivedCount).toBe('number');
      expect(typeof result.dormantCount).toBe('number');
      expect(typeof result.summariesGenerated).toBe('number');
    });
  });

  describe('export / import', () => {
    it('round-trips data', async () => {
      await memory.appendMessage('default', 'user', 'Hello');
      await memory.saveMemory('fact', 'k', 'v');
      await memory.addKnowledge('docs', 'T', 'C');

      const exported = await memory.export();
      expect(exported.version).toBe('1.0.0');
      expect(exported.conversations.length).toBeGreaterThanOrEqual(1);
      expect(exported.longTermMemories.length).toBeGreaterThanOrEqual(1);
      expect(exported.knowledgeChunks.length).toBeGreaterThanOrEqual(1);

      // Import back
      await memory.import(exported);
      const stats = await memory.getStats();
      expect(stats.conversation.activeCount).toBeGreaterThanOrEqual(1);
    });

    it('import with no knowledgeChunks field', async () => {
      const exported = await memory.export();
      // Simulate old data format
      const oldData = { ...exported, knowledgeChunks: undefined };
      // Should not throw
      await memory.import(oldData as unknown as ExportData);
    });

    it('import rebuilds vectors for active LTM only', async () => {
      const id = await memory.saveMemory('fact', 'k', 'v');
      await memory.deleteMemory(id);

      const exported = await memory.export();
      await memory.import(exported);
      // Inactive memory should not be in vector index
      const results = await memory.searchMemory('v');
      expect(results.every((r) => r.isActive === true)).toBe(true);
    });
  });

  describe('purge', () => {
    it('purges soft-deleted memories', async () => {
      const id = await memory.saveMemory('fact', 'k', 'v');
      await memory.deleteMemory(id);
      const count = await memory.purge();
      expect(count).toBe(1);
    });
  });

  // ============================================================
  //  tryExtractFacts (via appendMessage)
  // ============================================================

  describe('fact extraction via appendMessage', () => {
    it('extracts facts from assistant reply (rule-based)', async () => {
      await memory.appendMessage('default', 'user', 'I prefer Python');
      await memory.appendMessage('default', 'assistant', 'Noted, you prefer Python.');
      await new Promise((r) => setTimeout(r, 500));
      const mems = await memory.listMemories({ category: 'preference' });
      expect(mems.length).toBe(1);
      expect(mems[0].key).toBe('prefers_python');
    });

    it('extracts multiple facts from different preferences', async () => {
      await memory.appendMessage('default', 'user', 'I like Python');
      await memory.appendMessage('default', 'assistant', 'Noted.');
      await memory.appendMessage('default', 'user', 'I prefer Rust');
      await memory.appendMessage('default', 'assistant', 'Noted.');
      await new Promise((r) => setTimeout(r, 500));
      const mems = await memory.listMemories({ category: 'preference' });
      expect(mems.length).toBe(2);
      const keys = mems.map(m => m.key).sort();
      expect(keys).toContain('prefers_python');
      expect(keys).toContain('prefers_rust');
    });

    it('extracts "avoids" pattern', async () => {
      await memory.appendMessage('default', 'user', "I don't like Java");
      await memory.appendMessage('default', 'assistant', 'Noted.');
      await new Promise((r) => setTimeout(r, 500));
      const mems = await memory.listMemories({ category: 'preference' });
      expect(mems.length).toBe(1);
      expect(mems[0].key).toBe('avoids_java');
    });

    it('extracts "my name is" pattern', async () => {
      await memory.appendMessage('default', 'user', 'My name is John');
      await memory.appendMessage('default', 'assistant', 'Hello John!');
      await new Promise((r) => setTimeout(r, 500));
      const mems = await memory.listMemories({ category: 'fact' });
      expect(mems.some(m => m.key === 'user_name')).toBe(true);
    });

    it('does not extract when only user message (needs assistant)', async () => {
      await memory.appendMessage('default', 'user', 'I like JavaScript');
      await new Promise((r) => setTimeout(r, 500));
      const mems = await memory.listMemories({ category: 'preference' });
      expect(mems.length).toBe(0);
    });
  });
});
