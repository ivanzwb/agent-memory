import type { ResolvedConfig, MemoryItem } from '../types';
import type { SqliteStorage } from '../storage/sqlite';

/**
 * Decay manager: identifies dormant memories and triggers warnings.
 */
export class DecayManager {
  constructor(
    private config: ResolvedConfig,
    private storage: SqliteStorage,
  ) {}

  /**
   * Run decay detection: find memories that should enter dormant state.
   * Returns count of newly dormant items.
   */
  runDecayCheck(): number {
    const dormantThresholdMs = this.config.decay.dormantAfterDays * 24 * 3600 * 1000;
    const dormantBefore = Date.now() - dormantThresholdMs;

    const candidates = this.storage.findDormantCandidates(dormantBefore);
    let dormantCount = 0;

    for (const row of candidates) {
      dormantCount++;
      if (this.config.onDecayWarning) {
        const item: MemoryItem = {
          id: row.id,
          category: row.category as MemoryItem['category'],
          key: row.key,
          value: row.value,
          confidence: row.confidence,
          accessCount: row.access_count,
          lastAccessed: row.last_accessed,
          isActive: row.is_active === 1,
          createdAt: row.created_at,
        };
        this.config.onDecayWarning(item);
      }
    }

    return dormantCount;
  }

  /**
   * Check if a memory is dormant (for scoring adjustments).
   */
  isDormant(createdAt: number, lastAccessed: number | null): boolean {
    const dormantThresholdMs = this.config.decay.dormantAfterDays * 24 * 3600 * 1000;
    const referenceTime = lastAccessed ?? createdAt;
    return (Date.now() - referenceTime) > dormantThresholdMs;
  }

  /**
   * Compute a decay factor (0-1) for scoring. 1 = fresh, approaches 0 for old.
   */
  decayFactor(createdAt: number, lastAccessed: number | null): number {
    const referenceTime = lastAccessed ?? createdAt;
    const ageMs = Date.now() - referenceTime;
    const halfLifeMs = this.config.decay.dormantAfterDays * 24 * 3600 * 1000;
    // Exponential decay with half-life = dormantAfterDays
    return Math.pow(0.5, ageMs / halfLifeMs);
  }
}
