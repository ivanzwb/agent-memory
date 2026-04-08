import type { LLMProvider } from '../types';
import type { ConversationRow, ResolvedConfig } from '../types';
import type { SqliteStorage } from '../storage/sqlite';
import type { AuditLogger } from '../audit/logger';

/**
 * Archive scheduler: compresses old conversation messages into long-term episodic memories.
 */
export class ArchiveScheduler {
  constructor(
    private config: ResolvedConfig,
    private storage: SqliteStorage,
    private saveLtm: (category: 'episodic', key: string, value: string, confidence: number) => Promise<string>,
    private audit: AuditLogger,
  ) {}

  /**
   * Check if archiving conditions are met and run if so.
   * Archives by conversation_id to keep each conversation's messages together.
   * Returns number of messages archived.
   */
  async tryArchive(): Promise<{ archivedCount: number; summariesGenerated: number }> {
    // Check quiet period
    const latestTime = this.storage.getLatestMessageTime();
    if (latestTime) {
      const silentMs = Date.now() - latestTime;
      const quietMs = this.config.archive.quietMinutes * 60 * 1000;
      if (silentMs < quietMs) {
        return { archivedCount: 0, summariesGenerated: 0 };
      }
    }

    // Find candidates older than window, grouped by conversation_id
    const windowMs = this.config.archive.windowHours * 3600 * 1000;
    const cutoff = Date.now() - windowMs;
    const groups = this.storage.getArchiveCandidatesGrouped(cutoff, this.config.archive.maxBatch);

    // Check if total candidates meet minimum batch requirement
    const totalCandidates = groups.reduce((sum, g) => sum + g.length, 0);
    if (totalCandidates < this.config.archive.minBatch) {
      return { archivedCount: 0, summariesGenerated: 0 };
    }

    let archivedCount = 0;
    let summariesGenerated = 0;

    // Archive each conversation group separately
    for (const group of groups) {
      if (group.length === 0) continue;

      // Generate summary if LLM is available
      let summary: string | null = null;
      if (this.config.llm) {
        summary = await this.generateSummary(this.config.llm, group);
        if (summary) summariesGenerated++;
      }

      // Save episodic memory with conversation_id in key
      const convId = group[0].conversation_id;
      const key = `session_${convId}_${new Date(group[0].created_at).toISOString().slice(0, 10)}`;
      const value = summary || `Archived ${group.length} messages from conversation ${convId}`;
      const ltmId = await this.saveLtm('episodic', key, value, 0.7);

      // Mark messages as archived
      const ids = group.map((c) => c.id);
      this.storage.markArchived(ids, ltmId, summary);
      archivedCount += ids.length;

      this.audit.log({
        action: 'archive',
        details: `Archived conversation ${convId}: ${ids.length} messages → ${ltmId}`,
      });
    }

    return { archivedCount, summariesGenerated };
  }

  /**
   * Capacity-based archiving: when we hit the max active conversation message limit,
   * archive the oldest conversations first (by first message time) to free up at
   * least `minMessagesToFree` messages. This ignores quiet period, window, and
   * minBatch constraints so it can operate under heavy load.
   */
  async tryArchiveForCapacity(minMessagesToFree: number): Promise<{ archivedCount: number; summariesGenerated: number }> {
    if (minMessagesToFree <= 0) {
      return { archivedCount: 0, summariesGenerated: 0 };
    }

    // Get all active messages ordered by time
    const rows = this.storage.getActiveMessages();
    if (!rows.length) return { archivedCount: 0, summariesGenerated: 0 };

    // Group by conversation_id and track the first message time for ordering
    const byConv = new Map<string, { firstCreatedAt: number; messages: ConversationRow[] }>();
    for (const row of rows) {
      let group = byConv.get(row.conversation_id);
      if (!group) {
        group = { firstCreatedAt: row.created_at, messages: [] };
        byConv.set(row.conversation_id, group);
      }
      group.messages.push(row);
      if (row.created_at < group.firstCreatedAt) group.firstCreatedAt = row.created_at;
    }

    const orderedGroups = Array.from(byConv.values()).sort(
      (a, b) => a.firstCreatedAt - b.firstCreatedAt,
    );

    const selected: ConversationRow[][] = [];
    let toFree = 0;
    for (const g of orderedGroups) {
      if (toFree >= minMessagesToFree) break;
      selected.push(g.messages);
      toFree += g.messages.length;
    }

    if (selected.length === 0) return { archivedCount: 0, summariesGenerated: 0 };

    let archivedCount = 0;
    let summariesGenerated = 0;

    // Reuse the same archiving logic as time-based archiving
    for (const group of selected) {
      if (group.length === 0) continue;

      let summary: string | null = null;
      if (this.config.llm) {
        summary = await this.generateSummary(this.config.llm, group);
        if (summary) summariesGenerated++;
      }

      const convId = group[0].conversation_id;
      const key = `session_${convId}_${new Date(group[0].created_at).toISOString().slice(0, 10)}`;
      const value = summary || `Archived ${group.length} messages from conversation ${convId}`;
      const ltmId = await this.saveLtm('episodic', key, value, 0.7);

      const ids = group.map((c) => c.id);
      this.storage.markArchived(ids, ltmId, summary);
      archivedCount += ids.length;

      this.audit.log({
        action: 'archive',
        details: `Archived conversation ${convId}: ${ids.length} messages → ${ltmId}`,
      });
    }

    return { archivedCount, summariesGenerated };
  }

  private async generateSummary(llm: LLMProvider, messages: ConversationRow[]): Promise<string | null> {
    const text = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const prompt = `Summarize the following conversation in 3-5 sentences. Focus on key decisions, facts mentioned, and action items.

${text}

Summary:`;

    try {
      return await llm.generate(prompt);
    } catch {
      return null;
    }
  }
}
