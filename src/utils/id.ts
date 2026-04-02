import * as crypto from 'crypto';

/**
 * Generate a unique long-term memory ID.
 * Format: ltm_{timestamp}_{random6}
 */
export function generateMemoryId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(3).toString('hex');
  return `ltm_${ts}_${rand}`;
}

/**
 * Generate a unique embedding ID.
 */
export function generateEmbeddingId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(3).toString('hex');
  return `emb_${ts}_${rand}`;
}
