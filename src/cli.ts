#!/usr/bin/env node

import { createMemory } from './index';
import type { AgentMemory } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ============================================================
// Argument parsing
// ============================================================

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = args[++i] ?? '';
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// ============================================================
// Helpers
// ============================================================

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

async function withMemory<T>(flags: Record<string, string>, fn: (mem: AgentMemory) => Promise<T>): Promise<T> {
  const dataDir = flags['data-dir'] || undefined;
  const mem = await createMemory(dataDir ? { dataDir } : undefined);
  try {
    return await fn(mem);
  } finally {
    await mem.close();
  }
}

// ============================================================
// Commands
// ============================================================

async function cmdAppend(args: ParsedArgs): Promise<void> {
  const conversationId = args.flags['conversation-id'] || args.flags['c'];
  if (!conversationId) die('Usage: memory append --conversation-id <id> <role> <content>');

  const role = args.positional[0] as 'user' | 'assistant' | 'system';
  const content = args.positional.slice(1).join(' ');
  if (!role || !content) die('Usage: memory append --conversation-id <id> <role> <content>');
  if (!['user', 'assistant', 'system'].includes(role)) die('Role must be user, assistant, or system');

  await withMemory(args.flags, async (mem) => {
    const id = await mem.appendMessage(conversationId, role, content);
    console.log(`Message appended (id: ${id})`);
  });
}

async function cmdHistory(args: ParsedArgs): Promise<void> {
  const limit = args.flags['limit'] ? parseInt(args.flags['limit'], 10) : undefined;
  await withMemory(args.flags, async (mem) => {
    const messages = await mem.getConversationHistory(limit);
    printJson(messages);
  });
}

async function cmdSave(args: ParsedArgs): Promise<void> {
  const category = args.positional[0] as 'preference' | 'fact' | 'episodic' | 'procedural';
  const key = args.positional[1];
  const value = args.positional.slice(2).join(' ');
  if (!category || !key || !value) die('Usage: memory save <category> <key> <value>');

  const confidence = args.flags['confidence'] ? parseFloat(args.flags['confidence']) : undefined;
  await withMemory(args.flags, async (mem) => {
    const id = await mem.saveMemory(category, key, value, confidence);
    console.log(`Memory saved (id: ${id})`);
  });
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) die('Usage: memory search <query>');

  const topK = args.flags['top-k'] ? parseInt(args.flags['top-k'], 10) : undefined;
  await withMemory(args.flags, async (mem) => {
    const [conversation, longTerm] = await Promise.all([
      mem.searchConversation(query, topK),
      mem.searchMemory(query, topK),
    ]);
    printJson({ conversation, longTerm });
  });
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const category = args.flags['category'] as any;
  await withMemory(args.flags, async (mem) => {
    const filter = category ? { category } : undefined;
    const items = await mem.listMemories(filter);
    printJson(items);
  });
}

async function cmdDelete(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) die('Usage: memory delete <id>');

  await withMemory(args.flags, async (mem) => {
    await mem.deleteMemory(id);
    console.log(`Memory deleted (id: ${id})`);
  });
}

async function cmdContext(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) die('Usage: memory context <query>');

  await withMemory(args.flags, async (mem) => {
    const ctx = await mem.assembleContext(query);
    console.log(ctx.text);
    console.error(`\n--- ${ctx.tokenCount} tokens, ${ctx.sources.length} sources ---`);
  });
}

async function cmdStats(args: ParsedArgs): Promise<void> {
  await withMemory(args.flags, async (mem) => {
    const stats = await mem.getStats();
    printJson(stats);
  });
}

async function cmdMaintenance(args: ParsedArgs): Promise<void> {
  await withMemory(args.flags, async (mem) => {
    const result = await mem.runMaintenance();
    printJson(result);
  });
}

async function cmdExport(args: ParsedArgs): Promise<void> {
  const outFile = args.flags['output'] || args.positional[0];
  await withMemory(args.flags, async (mem) => {
    const data = await mem.export();
    const json = JSON.stringify(data, null, 2);
    if (outFile) {
      fs.writeFileSync(path.resolve(outFile), json, 'utf-8');
      console.log(`Exported to ${outFile}`);
    } else {
      console.log(json);
    }
  });
}

async function cmdImport(args: ParsedArgs): Promise<void> {
  const inFile = args.positional[0];
  if (!inFile) die('Usage: memory import <file>');

  const raw = fs.readFileSync(path.resolve(inFile), 'utf-8');
  const data = JSON.parse(raw);
  await withMemory(args.flags, async (mem) => {
    await mem.import(data);
    console.log(`Imported from ${inFile}`);
  });
}

async function cmdPurge(args: ParsedArgs): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirm = await new Promise<string>((resolve) => {
    rl.question('This will permanently delete all soft-deleted memories. Continue? (yes/no) ', resolve);
  });
  rl.close();

  if (confirm !== 'yes') {
    console.log('Aborted.');
    return;
  }

  await withMemory(args.flags, async (mem) => {
    const count = await mem.purge();
    console.log(`Purged ${count} entries`);
  });
}

// Knowledge base commands
async function cmdKbAdd(args: ParsedArgs): Promise<void> {
  const source = args.flags['source'];
  const title = args.flags['title'];
  const contentArg = args.positional.join(' ');
  const file = args.flags['file'];

  if (!source || !title) die('Usage: memory kb-add --source <source> --title <title> [--file <path>] [content]');

  const content = file ? fs.readFileSync(path.resolve(file), 'utf-8') : contentArg;
  if (!content) die('Provide content as argument or via --file');

  await withMemory(args.flags, async (mem) => {
    const id = await mem.addKnowledge(source, title, content);
    console.log(`Knowledge added (id: ${id})`);
  });
}

async function cmdKbList(args: ParsedArgs): Promise<void> {
  const source = args.flags['source'];
  await withMemory(args.flags, async (mem) => {
    const chunks = await mem.listKnowledge(source);
    printJson(chunks.map((c) => ({ id: c.id, source: c.source, title: c.title, tokenCount: c.tokenCount })));
  });
}

async function cmdKbSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) die('Usage: memory kb-search <query>');

  const topK = args.flags['top-k'] ? parseInt(args.flags['top-k'], 10) : undefined;
  await withMemory(args.flags, async (mem) => {
    const results = await mem.searchKnowledge(query, topK);
    printJson(results);
  });
}

async function cmdKbRemove(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  const source = args.flags['source'];
  if (!id && !source) die('Usage: memory kb-remove <id> or --source <source>');

  await withMemory(args.flags, async (mem) => {
    if (source) {
      const count = await mem.removeKnowledgeBySource(source);
      console.log(`Removed ${count} chunks from source "${source}"`);
    } else {
      await mem.removeKnowledge(id!);
      console.log(`Knowledge removed (id: ${id})`);
    }
  });
}

// ============================================================
// Help
// ============================================================

function printHelp(): void {
  console.log(`
memory — CLI for the Agent Memory System

Usage: memory <command> [options]

Global Options:
  --data-dir <path>   Data directory (default: $AGENT_MEMORY_DATA_DIR or ./memoryData)

Commands:
  append <role> <content>         Append a conversation message (role: user|assistant|system)
  history [--limit N]             Show recent conversation history
  save <category> <key> <value>   Save to long-term memory (category: preference|fact|episodic|procedural)
    [--confidence N]              Confidence score 0-1
  search <query> [--top-k N]      Search conversation + long-term memory
  list [--category <cat>]         List memory entries
  delete <id>                     Soft-delete a memory entry
  context <query>                 Assemble context for a query (retrieval + ranking + budget)

  kb-add --source <s> --title <t> [--file <path>] [content]
                                  Add a knowledge chunk
  kb-list [--source <s>]          List knowledge chunks
  kb-search <query> [--top-k N]  Search knowledge base
  kb-remove <id>                  Remove a knowledge chunk
  kb-remove --source <s>          Remove all chunks from a source

  stats                           Show memory statistics
  maintenance                     Run archive + decay maintenance
  export [--output <file>]        Export all data as JSON
  import <file>                   Import data from JSON file
  purge                           Permanently delete soft-deleted entries (interactive confirm)

  help                            Show this help message
`.trim());
}

// ============================================================
// Main
// ============================================================

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  append: cmdAppend,
  history: cmdHistory,
  save: cmdSave,
  search: cmdSearch,
  list: cmdList,
  delete: cmdDelete,
  context: cmdContext,
  stats: cmdStats,
  maintenance: cmdMaintenance,
  export: cmdExport,
  import: cmdImport,
  purge: cmdPurge,
  'kb-add': cmdKbAdd,
  'kb-list': cmdKbList,
  'kb-search': cmdKbSearch,
  'kb-remove': cmdKbRemove,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    printHelp();
    return;
  }

  const handler = COMMANDS[args.command];
  if (!handler) {
    console.error(`Unknown command: ${args.command}`);
    printHelp();
    process.exit(1);
  }

  await handler(args);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
