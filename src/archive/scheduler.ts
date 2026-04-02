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

    // Find candidates older than window
    const windowMs = this.config.archive.windowHours * 3600 * 1000;
    const cutoff = Date.now() - windowMs;
    const candidates = this.storage.getArchiveCandidates(cutoff, this.config.archive.maxBatch);

    if (candidates.length < this.config.archive.minBatch) {
      return { archivedCount: 0, summariesGenerated: 0 };
    }

    // Generate summary if LLM is available
    let summary: string | null = null;
    let summariesGenerated = 0;

    if (this.config.llm) {
      summary = await this.generateSummary(this.config.llm, candidates);
      summariesGenerated = summary ? 1 : 0;
    }

    // Save episodic memory
    const key = `session_summary_${new Date(candidates[0].created_at).toISOString().slice(0, 10)}`;
    const value = summary || `Archived ${candidates.length} messages from conversation`;
    const ltmId = await this.saveLtm('episodic', key, value, 0.7);

    // Mark messages as archived
    const ids = candidates.map((c) => c.id);
    this.storage.markArchived(ids, ltmId, summary);

    this.audit.log({
      action: 'archive',
      details: `Archived ${ids.length} messages → ${ltmId}`,
    });

    return { archivedCount: ids.length, summariesGenerated };
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
