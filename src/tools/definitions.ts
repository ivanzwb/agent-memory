import type { ToolFormat } from '../types';

// ============================================================
// JSON Schema types (subset used by LLM tool definitions)
// ============================================================

/** A single property in a JSON Schema object */
interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: JsonSchemaProperty;
}

/** Standard JSON Schema for tool parameters (type: "object") */
interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Internal tool specification using JSON Schema */
interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

// ============================================================
// Public API
// ============================================================

/**
 * Generate LLM tool definitions for memory operations.
 * Supports OpenAI, Anthropic, and LangChain formats.
 */
export function getToolDefinitions(format: ToolFormat): unknown[] {
  return TOOL_SPECS.map((spec) => formatTool(spec, format));
}

/** Map a tool name to the corresponding spec */
export function resolveToolCall(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find((t) => t.name === name);
}

// ============================================================
// Tool Specifications (JSON Schema)
// ============================================================

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'memory_search',
    description: 'Search long-term memory by semantic similarity.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        topK: { type: 'integer', description: 'Max results to return', default: 5, minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description: 'Save a fact or preference to long-term memory.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Memory category', enum: ['preference', 'fact', 'episodic', 'procedural'] },
        key: { type: 'string', description: 'Short identifier for the memory' },
        value: { type: 'string', description: 'The content to remember' },
      },
      required: ['category', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_list',
    description: 'List active memory entries, optionally filtered by category.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category', enum: ['preference', 'fact', 'episodic', 'procedural'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_delete',
    description: 'Soft-delete a memory entry by ID.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get_history',
    description: 'Get recent conversation messages.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max messages to return', default: 20, minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge_read',
    description: 'Read the full content of a knowledge base document by its reference ID. Use this when the context contains a knowledge reference (ref:kb_...) and you need the complete text.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Knowledge chunk ID (e.g. kb_...)' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge_search',
    description: 'Search the knowledge base by semantic similarity. Returns titles and excerpts with reference IDs.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        topK: { type: 'integer', description: 'Max results to return', default: 5, minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

// ============================================================
// Format adapters
// ============================================================

function formatTool(spec: ToolSpec, format: ToolFormat): unknown {
  switch (format) {
    case 'openai':
      return formatOpenAI(spec);
    case 'anthropic':
      return formatAnthropic(spec);
    case 'langchain':
      return formatLangChain(spec);
    default:
      return formatOpenAI(spec);
  }
}

/** OpenAI / Vercel AI SDK format */
function formatOpenAI(spec: ToolSpec): unknown {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}

/** Anthropic SDK format */
function formatAnthropic(spec: ToolSpec): unknown {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  };
}

/** LangChain / LangGraph format */
function formatLangChain(spec: ToolSpec): unknown {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.parameters,
  };
}
