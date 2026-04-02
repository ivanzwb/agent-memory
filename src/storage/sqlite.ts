import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { ConversationRow, LongTermMemoryRow, KnowledgeChunkRow } from '../types';

/**
 * SQLite storage layer — manages conversation messages and long-term memory rows.
 */
export class SqliteStorage {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'memory.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        role            TEXT    NOT NULL,
        content         TEXT    NOT NULL,
        token_count     INTEGER NOT NULL DEFAULT 0,
        attachments     TEXT,
        related_task_id TEXT,
        metadata        TEXT,
        summary         TEXT,
        importance      REAL    NOT NULL DEFAULT 0.5,
        is_archived     INTEGER NOT NULL DEFAULT 0,
        ltm_ref_id      TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_archived_time
        ON conversations (is_archived, created_at);

      CREATE TABLE IF NOT EXISTS long_term_memories (
        id              TEXT    PRIMARY KEY,
        category        TEXT    NOT NULL,
        key             TEXT    NOT NULL,
        value           TEXT    NOT NULL,
        embedding_id    TEXT    NOT NULL,
        confidence      REAL    NOT NULL DEFAULT 0.7,
        access_count    INTEGER NOT NULL DEFAULT 0,
        last_accessed   INTEGER,
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ltm_active
        ON long_term_memories (is_active);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id              TEXT    PRIMARY KEY,
        source          TEXT    NOT NULL,
        title           TEXT    NOT NULL,
        content         TEXT    NOT NULL,
        embedding_id    TEXT    NOT NULL,
        token_count     INTEGER NOT NULL DEFAULT 0,
        metadata        TEXT,
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kb_source
        ON knowledge_chunks (source);
    `);
  }

  // ------- Conversation -------

  insertMessage(
    role: string,
    content: string,
    tokenCount: number,
    metadata?: Record<string, unknown>,
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (role, content, token_count, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      role,
      content,
      tokenCount,
      metadata ? JSON.stringify(metadata) : null,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  getActiveMessages(limit?: number): ConversationRow[] {
    const sql = limit
      ? `SELECT * FROM conversations WHERE is_archived = 0 ORDER BY created_at ASC LIMIT ?`
      : `SELECT * FROM conversations WHERE is_archived = 0 ORDER BY created_at ASC`;
    return limit
      ? (this.db.prepare(sql).all(limit) as ConversationRow[])
      : (this.db.prepare(sql).all() as ConversationRow[]);
  }

  getAllMessages(offset: number, limit: number): ConversationRow[] {
    return this.db
      .prepare(`SELECT * FROM conversations ORDER BY created_at ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as ConversationRow[];
  }

  getArchiveCandidates(beforeTimestamp: number, maxBatch: number): ConversationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE is_archived = 0 AND created_at < ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(beforeTimestamp, maxBatch) as ConversationRow[];
  }

  markArchived(ids: number[], ltmRefId: string, summary: string | null): void {
    const stmt = this.db.prepare(
      `UPDATE conversations SET is_archived = 1, ltm_ref_id = ?, summary = ? WHERE id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(ltmRefId, summary, id);
      }
    });
    tx();
  }

  countActiveMessages(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM conversations WHERE is_archived = 0`)
      .get() as { cnt: number };
    return row.cnt;
  }

  countArchivedMessages(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM conversations WHERE is_archived = 1`)
      .get() as { cnt: number };
    return row.cnt;
  }

  getLatestMessageTime(): number | null {
    const row = this.db
      .prepare(`SELECT MAX(created_at) as t FROM conversations WHERE is_archived = 0`)
      .get() as { t: number | null };
    return row.t;
  }

  // ------- Long-term Memory -------

  insertLongTermMemory(row: LongTermMemoryRow): void {
    this.db
      .prepare(
        `INSERT INTO long_term_memories
         (id, category, key, value, embedding_id, confidence, access_count, last_accessed, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.category,
        row.key,
        row.value,
        row.embedding_id,
        row.confidence,
        row.access_count,
        row.last_accessed,
        row.is_active,
        row.created_at,
      );
  }

  getLongTermMemory(id: string): LongTermMemoryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM long_term_memories WHERE id = ?`)
      .get(id) as LongTermMemoryRow | undefined;
  }

  listLongTermMemories(filter?: {
    category?: string;
    isActive?: number;
    createdAfter?: number;
    createdBefore?: number;
  }): LongTermMemoryRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.category) {
      clauses.push('category = ?');
      params.push(filter.category);
    }
    if (filter?.isActive !== undefined) {
      clauses.push('is_active = ?');
      params.push(filter.isActive);
    }
    if (filter?.createdAfter) {
      clauses.push('created_at > ?');
      params.push(filter.createdAfter);
    }
    if (filter?.createdBefore) {
      clauses.push('created_at < ?');
      params.push(filter.createdBefore);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM long_term_memories ${where} ORDER BY created_at DESC`)
      .all(...params) as LongTermMemoryRow[];
  }

  softDeleteMemory(id: string): void {
    this.db
      .prepare(`UPDATE long_term_memories SET is_active = 0 WHERE id = ?`)
      .run(id);
  }

  refreshAccess(id: string): void {
    this.db
      .prepare(
        `UPDATE long_term_memories
         SET access_count = access_count + 1, last_accessed = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  getActiveLongTermMemoryIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM long_term_memories WHERE is_active = 1`)
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  countLongTermByStatus(): { active: number; dormant: number; deleted: number } {
    const now = Date.now();
    // We'll compute dormancy externally; here just provide raw counts
    const active = (
      this.db
        .prepare(`SELECT COUNT(*) as cnt FROM long_term_memories WHERE is_active = 1`)
        .get() as { cnt: number }
    ).cnt;
    const deleted = (
      this.db
        .prepare(`SELECT COUNT(*) as cnt FROM long_term_memories WHERE is_active = 0`)
        .get() as { cnt: number }
    ).cnt;
    return { active, dormant: 0, deleted }; // dormant computed by decay manager
  }

  /** Find memories that should become dormant */
  findDormantCandidates(dormantBeforeTimestamp: number): LongTermMemoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM long_term_memories
         WHERE is_active = 1
           AND (last_accessed IS NULL OR last_accessed < ?)
           AND created_at < ?`,
      )
      .all(dormantBeforeTimestamp, dormantBeforeTimestamp) as LongTermMemoryRow[];
  }

  purgeDeleted(): number {
    const info = this.db
      .prepare(`DELETE FROM long_term_memories WHERE is_active = 0`)
      .run();
    return info.changes;
  }

  // ------- Knowledge Base -------

  insertKnowledgeChunk(row: KnowledgeChunkRow): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_chunks
         (id, source, title, content, embedding_id, token_count, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.source, row.title, row.content,
        row.embedding_id, row.token_count, row.metadata, row.created_at,
      );
  }

  getKnowledgeChunk(id: string): KnowledgeChunkRow | undefined {
    return this.db
      .prepare(`SELECT * FROM knowledge_chunks WHERE id = ?`)
      .get(id) as KnowledgeChunkRow | undefined;
  }

  listKnowledgeChunks(source?: string): KnowledgeChunkRow[] {
    if (source) {
      return this.db
        .prepare(`SELECT * FROM knowledge_chunks WHERE source = ? ORDER BY created_at ASC`)
        .all(source) as KnowledgeChunkRow[];
    }
    return this.db
      .prepare(`SELECT * FROM knowledge_chunks ORDER BY created_at ASC`)
      .all() as KnowledgeChunkRow[];
  }

  deleteKnowledgeChunk(id: string): string | undefined {
    const row = this.getKnowledgeChunk(id);
    if (!row) return undefined;
    this.db.prepare(`DELETE FROM knowledge_chunks WHERE id = ?`).run(id);
    return row.embedding_id;
  }

  deleteKnowledgeBySource(source: string): KnowledgeChunkRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM knowledge_chunks WHERE source = ?`)
      .all(source) as KnowledgeChunkRow[];
    this.db.prepare(`DELETE FROM knowledge_chunks WHERE source = ?`).run(source);
    return rows;
  }

  countKnowledgeChunks(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) as cnt FROM knowledge_chunks`)
        .get() as { cnt: number }
    ).cnt;
  }

  countKnowledgeSources(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(DISTINCT source) as cnt FROM knowledge_chunks`)
        .get() as { cnt: number }
    ).cnt;
  }

  getAllKnowledgeIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM knowledge_chunks`)
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Get DB file size in bytes */
  getDbSize(): number {
    const dbPath = this.db.name;
    try {
      return fs.statSync(dbPath).size;
    } catch {
      return 0;
    }
  }

  // ------- Export / Import -------

  exportAll(): { conversations: ConversationRow[]; longTermMemories: LongTermMemoryRow[]; knowledgeChunks: KnowledgeChunkRow[] } {
    const conversations = this.db
      .prepare(`SELECT * FROM conversations ORDER BY created_at ASC`)
      .all() as ConversationRow[];
    const longTermMemories = this.db
      .prepare(`SELECT * FROM long_term_memories ORDER BY created_at ASC`)
      .all() as LongTermMemoryRow[];
    const knowledgeChunks = this.db
      .prepare(`SELECT * FROM knowledge_chunks ORDER BY created_at ASC`)
      .all() as KnowledgeChunkRow[];
    return { conversations, longTermMemories, knowledgeChunks };
  }

  importAll(conversations: ConversationRow[], longTermMemories: LongTermMemoryRow[], knowledgeChunks: KnowledgeChunkRow[] = []): void {
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM conversations`);
      this.db.exec(`DELETE FROM long_term_memories`);
      this.db.exec(`DELETE FROM knowledge_chunks`);

      const insertConv = this.db.prepare(`
        INSERT INTO conversations
        (id, role, content, token_count, attachments, related_task_id, metadata, summary, importance, is_archived, ltm_ref_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of conversations) {
        insertConv.run(
          c.id, c.role, c.content, c.token_count, c.attachments,
          c.related_task_id, c.metadata, c.summary, c.importance,
          c.is_archived, c.ltm_ref_id, c.created_at,
        );
      }

      const insertLtm = this.db.prepare(`
        INSERT INTO long_term_memories
        (id, category, key, value, embedding_id, confidence, access_count, last_accessed, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of longTermMemories) {
        insertLtm.run(
          m.id, m.category, m.key, m.value, m.embedding_id,
          m.confidence, m.access_count, m.last_accessed, m.is_active, m.created_at,
        );
      }

      const insertKb = this.db.prepare(`
        INSERT INTO knowledge_chunks
        (id, source, title, content, embedding_id, token_count, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const k of knowledgeChunks) {
        insertKb.run(
          k.id, k.source, k.title, k.content, k.embedding_id,
          k.token_count, k.metadata, k.created_at,
        );
      }
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
