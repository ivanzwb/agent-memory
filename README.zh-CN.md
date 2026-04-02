# agent-memory

为 AI Agent 提供持久化记忆能力的 TypeScript 库 —— 对话历史、长期记忆（向量语义检索）、知识库、自动事实提取。

[English](README.md) | 中文

> **设计文档**：[English](doc/memory-system-design.md) | [中文](doc/记忆系统框架设计.md)

## 特性

- **三层记忆**：工作记忆（瞬时）→ 对话记忆（会话级）→ 长期记忆（持久化）
- **知识库**：预加载参考文档，按引用注入上下文，LLM 按需加载全文
- **混合检索**：关键词 + 向量语义搜索，跨对话、记忆、知识库三路并行检索
- **Token 预算**：上下文组装自动排序 + 预算裁剪，支持运行时动态调整
- **自然遗忘**：基于访问频率的衰减机制，模拟人类遗忘曲线
- **嵌入式存储**：SQLite + HNSW 向量索引，零外部依赖
- **LLM 工具集成**：导出 OpenAI / Anthropic / LangChain 格式的工具定义
- **CLI 工具**：内置命令行，无需编写代码即可操作记忆系统
- **不绑定任何 LLM 或 Embedding 提供商**：内置本地 Embedding，支持注入自定义实现

## 安装

```bash
npm install agent-memory
```

需要 Node.js >= 18。

## 快速开始

```ts
import { createMemory } from 'agent-memory';

const memory = await createMemory();

// 追加对话消息
await memory.appendMessage('user', '我偏好使用 TypeScript');
await memory.appendMessage('assistant', '好的，后续示例都用 TypeScript。');

// 保存事实到长期记忆
await memory.saveMemory('preference', 'language', '用户偏好 TypeScript');

// 组装上下文，准备注入 Prompt
const ctx = await memory.assembleContext('应该用什么语言？');
// ctx.text → 格式化的记忆上下文，可直接拼入 Prompt
// ctx.tokenCount → 消耗的 Token 数
// ctx.sources → 检索来源审计

// 释放资源
await memory.close();
```

## 配置

所有选项均可选，都有合理默认值：

```ts
const memory = await createMemory({
  // 数据目录（默认：$AGENT_MEMORY_DATA_DIR || './memoryData'）
  dataDir: './my-agent-data',

  // 自定义 Embedding 提供者（默认：内置 all-MiniLM-L6-v2，384 维）
  embedding: myEmbeddingProvider,

  // LLM 提供者，用于归档摘要和事实提取（默认：无）
  llm: myLLMProvider,

  // Token 预算
  tokenBudget: {
    contextWindow: 128000,
    systemPromptReserve: 2000,
    outputReserve: 1000,
  },

  // 归档调度器
  archive: {
    quietMinutes: 5,
    windowHours: 24,
    minBatch: 5,
    maxBatch: 20,
  },

  // 衰减 / 遗忘
  decay: {
    dormantAfterDays: 90,
    expireAfterDays: 180,
  },

  // 容量限制
  limits: {
    maxConversationMessages: 500,
    maxLongTermMemories: 1000,
  },

  // 衰减告警回调
  onDecayWarning: (item) => console.log('衰减中：', item.key),
});
```

## 知识库

预加载参考文档，Agent 可按需访问：

```ts
// 添加知识块
await memory.addKnowledge('api-docs', '认证', '所有请求需携带 Bearer Token...');
await memory.addKnowledgeBatch([
  { source: 'faq', title: '定价', content: '套餐起步价...' },
  { source: 'faq', title: '退款', content: '30 天内可退...' },
]);

// 搜索知识库
const results = await memory.searchKnowledge('如何认证', 5);

// 替换某个来源（全部删除后重新添加）
await memory.removeKnowledgeBySource('api-docs');
```

`assembleContext()` 运行时，知识库结果仅注入**标题 + 摘要 + 引用 ID**。LLM 可通过 `knowledge_read(id)` 工具按需加载全文。

## LLM 工具集成

将记忆操作导出为 Function Calling 工具定义：

```ts
// 获取工具定义
const tools = memory.getToolDefinitions('openai'); // 或 'anthropic' | 'langchain'

// 在 tool call handler 中执行
const result = await memory.executeTool('memory_search', { query: '用户偏好' });
```

可用工具：`memory_search`、`memory_save`、`memory_list`、`memory_delete`、`memory_get_history`、`knowledge_read`、`knowledge_search`。

## 自定义提供者

### Embedding 提供者

```ts
const memory = await createMemory({
  embedding: {
    dimensions: 1536,
    async embed(text: string): Promise<number[]> {
      // 调用 OpenAI、Cohere、Ollama 等
      return await myEmbeddingAPI(text);
    },
  },
});
```

### LLM 提供者

启用归档摘要生成和 LLM 事实提取：

```ts
const memory = await createMemory({
  llm: {
    async generate(prompt: string): Promise<string> {
      return await myLLM.complete(prompt);
    },
  },
});
```

## 动态 Token 预算

运行时更新或按次覆盖：

```ts
// 更新实例级预算
memory.updateTokenBudget({ contextWindow: 32000 });

// 单次调用覆盖
const ctx = await memory.assembleContext('查询', { contextWindow: 16000 });
```

## 命令行工具

安装后可直接在终端操作：

```bash
# 追加消息
agent-memory append user "我偏好深色模式"

# 搜索记忆
agent-memory search "用户偏好"

# 组装上下文
agent-memory context "用户喜欢什么？"

# 知识库管理
agent-memory kb-add --source api --title 认证 --file auth.md
agent-memory kb-list --source api
agent-memory kb-search "认证方式"

# 统计与运维
agent-memory stats
agent-memory maintenance
agent-memory export --output backup.json
agent-memory import backup.json
```

使用 `--data-dir <路径>` 指定数据目录。运行 `agent-memory help` 查看完整命令列表。

## 运维

```ts
// 手动触发归档 + 衰减检测
const result = await memory.runMaintenance();

// 导出 / 导入
const data = await memory.export();
await memory.import(data);

// 物理清除已软删除的记忆
await memory.purge();
```

## 架构

```
三层记忆 + 知识库
────────────────────────────────────
 L1  工作记忆        (进程内存，由 Agent Runtime 管理)
 L2  对话记忆        (SQLite，滑动窗口，自动归档)
 L3  长期记忆        (SQLite + HNSW 向量索引，语义检索)
 KB  知识库          (SQLite + HNSW 向量索引，按引用注入)

检索：L2 关键词 + L3 向量 + KB 向量 → 合并 → 排序 → 预算填充
```

## 许可证

MIT
