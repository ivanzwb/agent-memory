import { ArchiveScheduler } from '../../src/archive/scheduler';
import type { ResolvedConfig, ConversationRow } from '../../src/types';
import type { SqliteStorage } from '../../src/storage/sqlite';
import type { AuditLogger } from '../../src/audit/logger';

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    dataDir: '/tmp/test',
    embedding: { dimensions: 4, embed: async () => [1, 0, 0, 0] },
    llm: null,
    tokenBudget: { contextWindow: 128000, systemPromptReserve: 2000, outputReserve: 1000 },
    archive: { quietMinutes: 5, windowHours: 24, minBatch: 2, maxBatch: 20 },
    decay: { dormantAfterDays: 90, expireAfterDays: 180 },
    limits: { maxConversationMessages: 500, maxLongTermMemories: 1000 },
    onDecayWarning: null,
    ...overrides,
  };
}

function makeDeps() {
  const storage = {
    getLatestMessageTime: jest.fn().mockReturnValue(null),
    getArchiveCandidates: jest.fn().mockReturnValue([]),
    getArchiveCandidatesGrouped: jest.fn().mockReturnValue([]),
    getActiveMessages: jest.fn().mockReturnValue([]),
    markArchived: jest.fn(),
  } as unknown as jest.Mocked<SqliteStorage>;

  const saveLtm = jest.fn().mockResolvedValue('ltm_archive_1');

  const audit = {
    log: jest.fn(),
  } as unknown as jest.Mocked<AuditLogger>;

  return { storage, saveLtm, audit };
}

describe('ArchiveScheduler', () => {
  describe('tryArchive', () => {
    it('returns 0 when quiet period not met', async () => {
      const config = makeConfig();
      const { storage, saveLtm, audit } = makeDeps();
      // Latest message is recent (5s ago)
      (storage.getLatestMessageTime as jest.Mock).mockReturnValue(Date.now() - 5000);

      const scheduler = new ArchiveScheduler(config, storage, saveLtm, audit);
      const result = await scheduler.tryArchive();

      expect(result.archivedCount).toBe(0);
      expect(result.summariesGenerated).toBe(0);
    });

    it('returns 0 when too few candidates (below minBatch)', async () => {
      const config = makeConfig();
      const { storage, saveLtm, audit } = makeDeps();

      // Quiet period satisfied
      (storage.getLatestMessageTime as jest.Mock).mockReturnValue(Date.now() - 10 * 60 * 1000);
      // Only 1 candidate, minBatch = 2
      (storage.getArchiveCandidatesGrouped as jest.Mock).mockReturnValue([
        [
          { id: 1, conversation_id: 'conv1', role: 'user', content: 'old msg', token_count: 3, importance: 0.5, created_at: Date.now() - 48 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null } as ConversationRow,
        ],
      ]);

      const scheduler = new ArchiveScheduler(config, storage, saveLtm, audit);
      const result = await scheduler.tryArchive();
      expect(result.archivedCount).toBe(0);
    });

    it('archives messages without LLM (no summary)', async () => {
      const config = makeConfig();
      const { storage, saveLtm, audit } = makeDeps();

      // Quiet period satisfied (no messages = null time → proceeds)
      (storage.getLatestMessageTime as jest.Mock).mockReturnValue(null);

      const now = Date.now();
      const candidates: ConversationRow[] = [
        { id: 1, conversation_id: 'default', role: 'user', content: 'old msg 1', token_count: 3, importance: 0.5, created_at: now - 48 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
        { id: 2, conversation_id: 'default', role: 'assistant', content: 'old msg 2', token_count: 3, importance: 0.5, created_at: now - 47 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
      ];
      (storage.getArchiveCandidatesGrouped as jest.Mock).mockReturnValue([candidates]);

      const scheduler = new ArchiveScheduler(config, storage, saveLtm, audit);
      const result = await scheduler.tryArchive();

      expect(result.archivedCount).toBe(2);
      expect(result.summariesGenerated).toBe(0);
      expect(saveLtm).toHaveBeenCalledWith('episodic', expect.stringContaining('session_default'), expect.stringContaining('Archived 2 messages'), 0.7);
      expect(storage.markArchived).toHaveBeenCalledWith([1, 2], 'ltm_archive_1', null);
      expect(audit.log).toHaveBeenCalled();
    });

    it('archives messages with LLM summary', async () => {
      const llm = { generate: jest.fn().mockResolvedValue('Summary of the conversation.') };
      const config = makeConfig({ llm });
      const { storage, saveLtm, audit } = makeDeps();

      (storage.getLatestMessageTime as jest.Mock).mockReturnValue(null);

      const now = Date.now();
      const candidates: ConversationRow[] = [
        { id: 1, conversation_id: 'default', role: 'user', content: 'msg 1', token_count: 3, importance: 0.5, created_at: now - 48 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
        { id: 2, conversation_id: 'default', role: 'assistant', content: 'msg 2', token_count: 3, importance: 0.5, created_at: now - 47 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
      ];
      (storage.getArchiveCandidatesGrouped as jest.Mock).mockReturnValue([candidates]);

      const scheduler = new ArchiveScheduler(config, storage, saveLtm, audit);
      const result = await scheduler.tryArchive();

      expect(result.archivedCount).toBe(2);
      expect(result.summariesGenerated).toBe(1);
      expect(saveLtm).toHaveBeenCalledWith('episodic', expect.stringContaining('session_default'), 'Summary of the conversation.', 0.7);
      expect(storage.markArchived).toHaveBeenCalledWith([1, 2], 'ltm_archive_1', 'Summary of the conversation.');
    });

    it('handles LLM failure gracefully (null summary)', async () => {
      const llm = { generate: jest.fn().mockRejectedValue(new Error('LLM error')) };
      const config = makeConfig({ llm });
      const { storage, saveLtm, audit } = makeDeps();

      (storage.getLatestMessageTime as jest.Mock).mockReturnValue(null);

      const now = Date.now();
      const candidates: ConversationRow[] = [
        { id: 1, conversation_id: 'default', role: 'user', content: 'msg', token_count: 3, importance: 0.5, created_at: now - 48 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
        { id: 2, conversation_id: 'default', role: 'user', content: 'msg2', token_count: 3, importance: 0.5, created_at: now - 47 * 3600 * 1000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
      ];
      (storage.getArchiveCandidatesGrouped as jest.Mock).mockReturnValue([candidates]);

      const scheduler = new ArchiveScheduler(config, storage, saveLtm, audit);
      const result = await scheduler.tryArchive();

      expect(result.archivedCount).toBe(2);
      expect(result.summariesGenerated).toBe(0);
      // Should use fallback message
      expect(saveLtm).toHaveBeenCalledWith('episodic', expect.stringContaining('session_default'), expect.stringContaining('Archived 2 messages'), 0.7);
    });
  });

  describe('tryArchiveForCapacity', () => {
    it('archives oldest conversations to free requested messages', async () => {
      const config = makeConfig();
      const { storage, saveLtm, audit } = makeDeps();

      const now = Date.now();
      const rows: ConversationRow[] = [
        // Older conversation "a" (2 messages)
        { id: 1, conversation_id: 'a', role: 'user', content: 'a1', token_count: 1, importance: 0.5, created_at: now - 30000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
        { id: 2, conversation_id: 'a', role: 'assistant', content: 'a2', token_count: 1, importance: 0.5, created_at: now - 20000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
        // Newer conversation "b" (1 message)
        { id: 3, conversation_id: 'b', role: 'user', content: 'b1', token_count: 1, importance: 0.5, created_at: now - 10000, is_archived: 0, attachments: null, metadata: null, summary: null, ltm_ref_id: null },
      ];

      (storage.getActiveMessages as jest.Mock).mockReturnValue(rows);

      const scheduler = new ArchiveScheduler(config, storage, saveLtm, audit);
      const result = await scheduler.tryArchiveForCapacity(1);

      // Should archive the oldest conversation ("a" → 2 messages)
      expect(result.archivedCount).toBe(2);
      expect(storage.markArchived).toHaveBeenCalledWith([1, 2], 'ltm_archive_1', null);
      expect(saveLtm).toHaveBeenCalledWith(
        'episodic',
        expect.stringContaining('session_a'),
        expect.stringContaining('Archived 2 messages'),
        0.7,
      );
    });
  });
});
