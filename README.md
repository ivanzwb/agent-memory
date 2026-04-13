# agent-memory

[![npm version](https://img.shields.io/npm/v/agent-memory.svg)](https://www.npmjs.com/package/agent-memory)
[![license](https://img.shields.io/npm/l/agent-memory.svg)](https://github.com/ivanzwb/agent-memory/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/agent-memory.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg)](https://www.typescriptlang.org/)

TypeScript library providing persistent memory for AI agents — conversation history, long-term memory with vector search, knowledge base, and automatic fact extraction.

English | [中文](README.zh-CN.md)

> **Design Document**: [English](doc/memory-system-design.md) | [中文](doc/记忆系统框架设计.md)

## Why agent-memory?

Most AI agent frameworks lack built-in persistent memory. `agent-memory` fills this gap with a production-ready, embedded memory system for LLM-powered agents and chatbots. No external databases required — just `npm install` and go.

- Works with **OpenAI**, **Anthropic**, **LangChain**, and any LLM/embedding provider
- Ideal for building **RAG (Retrieval-Augmented Generation)** pipelines
- Drop-in **context management** with automatic token budgeting
- Local-first: all data stays on your machine via **SQLite** + **HNSW** vector index

## Features

- **Three-layer memory**: Working (transient) → Conversation (session) → Long-term (persistent)
- **Knowledge base**: Pre-loaded reference documents with ref-only injection and on-demand full-text loading
- **Hybrid retrieval**: Keyword + vector search across conversations, memories, and knowledge base
- **Token budget**: Context assembly with automatic ranking and budget-aware truncation
- **Natural forgetting**: Access-based decay simulating human memory curves
- **Embedded storage**: SQLite + HNSW vector index, zero external dependencies
- **LLM tool integration**: Export tool definitions for OpenAI / Anthropic / LangChain
- **CLI included**: Built-in command-line tool for debugging and data management
- **Not bound to any LLM or embedding provider**: Built-in local embedding, injectable custom providers

## Install

```bash
npm install agent-memory
```

Requires Node.js >= 20.

## Quick Start

```ts
import { createMemory } from 'agent-memory';

const memory = await createMemory();

// Append conversation messages
await memory.appendMessage('user', 'I prefer TypeScript over JavaScript');
await memory.appendMessage('assistant', 'Noted! I will use TypeScript in examples.');

// Save a fact to long-term memory
await memory.saveMemory('preference', 'language', 'User prefers TypeScript');

// Assemble context for the next LLM call
const ctx = await memory.assembleContext('What language should I use?');
// ctx.text → formatted memory context ready for prompt injection
// ctx.tokenCount → tokens used
// ctx.sources → retrieval audit trail

// Clean up
await memory.close();
```

## Configuration

All options are optional with sensible defaults:

```ts
const memory = await createMemory({
  // Data directory (default: $AGENT_MEMORY_DATA_DIR || './memoryData')
  dataDir: './my-agent-data',

  // Custom embedding provider (default: built-in all-MiniLM-L6-v2, 384d)
  embedding: myEmbeddingProvider,

  // LLM provider for archive summaries & fact extraction (default: none)
  llm: myLLMProvider,

  // Token budget
  tokenBudget: {
    contextWindow: 128000,
    systemPromptReserve: 2000,
    outputReserve: 1000,
  },

  // Archive scheduler
  archive: {
    quietMinutes: 5,
    windowHours: 24,
    minBatch: 5,
    maxBatch: 20,
  },

  // Decay / forgetting
  decay: {
    dormantAfterDays: 90,
    expireAfterDays: 180,
  },

  // Capacity limits
  limits: {
    maxConversationMessages: 500,
    maxLongTermMemories: 1000,
  },

  // Callback on decay warning
  onDecayWarning: (item) => console.log('Decaying:', item.key),
});
```

## Knowledge Base

Pre-load reference documents that the agent can access on demand:

```ts
// Add knowledge chunks
await memory.addKnowledge('api-docs', 'Authentication', 'All requests require Bearer token...');
await memory.addKnowledgeBatch([
  { source: 'faq', title: 'Pricing', content: 'Plans start at...' },
  { source: 'faq', title: 'Refunds', content: 'Refunds within 30 days...' },
]);

// Search knowledge
const results = await memory.searchKnowledge('how to authenticate', 5);

// Replace a source (remove all + re-add)
await memory.removeKnowledgeBySource('api-docs');
```

When `assembleContext()` runs, knowledge base results are injected as **title + excerpt + reference ID** only. The LLM can then call `knowledge_read(id)` to load full content on demand.

## LLM Tool Integration

Export memory operations as tool definitions for function calling:

```ts
// Get tool definitions for your LLM SDK
const tools = memory.getToolDefinitions('openai'); // or 'anthropic' | 'langchain'

// In your tool call handler
const result = await memory.executeTool('memory_search', { query: 'user preferences' });
```

Available tools: `memory_search`, `memory_save`, `memory_list`, `memory_delete`, `memory_get_history`, `knowledge_read`, `knowledge_search`.

## Custom Providers

### Embedding Provider

```ts
const memory = await createMemory({
  embedding: {
    dimensions: 1536,
    async embed(text: string): Promise<number[]> {
      // Call OpenAI, Cohere, Ollama, etc.
      return await myEmbeddingAPI(text);
    },
  },
});
```

### LLM Provider

Enables archive summarization and LLM-based fact extraction:

```ts
const memory = await createMemory({
  llm: {
    async generate(prompt: string): Promise<string> {
      return await myLLM.complete(prompt);
    },
  },
});
```

## Dynamic Token Budget

Update token budget at runtime or per-call:

```ts
// Update instance-level budget
memory.updateTokenBudget({ contextWindow: 32000 });

// Override memory context budget (tokens) for a single call
const ctx = await memory.assembleContext('query', 16000);
```

## CLI

The package includes a command-line tool for debugging and data management:

```bash
# Append a message
memory append user "I prefer dark mode"

# Search memories
memory search "user preferences"

# Assemble context
memory context "What does the user like?"

# Manage knowledge base
memory kb-add --source api --title Auth --file auth.md
memory kb-list --source api
memory kb-search "authentication"

# Stats & maintenance
memory stats
memory maintenance
memory export --output backup.json
memory import backup.json
```

Use `--data-dir <path>` to specify a custom data directory. Run `memory help` for the full command list.

## Maintenance

```ts
// Manual archive + decay detection
const result = await memory.runMaintenance();

// Export / import
const data = await memory.export();
await memory.import(data);

// Permanently remove soft-deleted entries
await memory.purge();
```

## Architecture

```
Three-layer memory + Knowledge Base
────────────────────────────────────
 L1  Working Memory     (in-process RAM, managed by Agent runtime)
 L2  Conversation Memory (SQLite, sliding window, auto-archive)
 L3  Long-term Memory    (SQLite + HNSW vectors, semantic search)
 KB  Knowledge Base      (SQLite + HNSW vectors, ref-only injection)

Retrieval: L2 keyword + L3 vector + KB vector → merge → rank → budget fill
```

## License

MIT

<sub>**Keywords**: AI agent memory, LLM memory, persistent memory, conversation history, vector search, semantic search, knowledge base, RAG, retrieval-augmented generation, fact extraction, token budget, context window management, SQLite vector database, HNSW, TypeScript AI library, chatbot memory, long-term memory, OpenAI memory, Anthropic memory, LangChain memory</sub>
