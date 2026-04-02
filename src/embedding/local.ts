import type { EmbeddingProvider } from '../types';
import { EmbeddingError } from '../errors';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Built-in local embedding provider using @xenova/transformers.
 * Model: all-MiniLM-L6-v2 (384 dimensions, ~80MB).
 * Downloaded on first use and cached locally.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  private pipeline: unknown = null;
  private modelDir: string;
  private initPromise: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.modelDir = path.join(dataDir, 'models');
    fs.mkdirSync(this.modelDir, { recursive: true });
  }

  private async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.doInit();
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      // Dynamic import to avoid issues if transformers is not available
      const { pipeline, env } = await import('@xenova/transformers');
      // Cache models in our data directory
      env.cacheDir = this.modelDir;
      env.allowLocalModels = true;
      this.pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    } catch (err) {
      throw new EmbeddingError(
        `Failed to initialize local embedding model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize();
    try {
      const extractor = this.pipeline as (text: string, options: Record<string, unknown>) => Promise<{ data: Float32Array }>;
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    } catch (err) {
      throw new EmbeddingError(
        `Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
