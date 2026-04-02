import * as path from 'path';
import * as fs from 'fs';

/**
 * Embedded HNSW vector index built on hnswlib-node.
 * Each agent instance has its own independent index file.
 */
export class VectorIndex {
  private index: HnswIndex | null = null;
  private indexPath: string;
  private dim: number;
  private maxElements: number;
  private idMap: Map<string, number> = new Map(); // external id -> internal label
  private labelMap: Map<number, string> = new Map(); // internal label -> external id
  private nextLabel = 0;
  private metaPath: string;

  constructor(dataDir: string, dimensions: number, maxElements = 10000) {
    const vecDir = path.join(dataDir, 'vectors');
    fs.mkdirSync(vecDir, { recursive: true });
    this.indexPath = path.join(vecDir, 'index.bin');
    this.metaPath = path.join(vecDir, 'meta.json');
    this.dim = dimensions;
    this.maxElements = maxElements;
  }

  async initialize(): Promise<void> {
    const { HierarchicalNSW } = await import('hnswlib-node');
    this.index = new HierarchicalNSW('cosine', this.dim) as HnswIndex;

    if (fs.existsSync(this.indexPath) && fs.existsSync(this.metaPath)) {
      // Restore existing index
      const meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf-8')) as IndexMeta;
      this.index.readIndexSync(this.indexPath);
      this.idMap = new Map(Object.entries(meta.idMap).map(([k, v]) => [k, v as number]));
      this.labelMap = new Map(Object.entries(meta.labelMap).map(([k, v]) => [Number(k), v as string]));
      this.nextLabel = meta.nextLabel;
    } else {
      this.index.initIndex(this.maxElements);
    }
  }

  add(id: string, vector: number[]): void {
    if (!this.index) throw new Error('VectorIndex not initialized');
    if (this.idMap.has(id)) {
      // Update existing vector
      const label = this.idMap.get(id)!;
      this.index.addPoint(vector, label);
    } else {
      // Resize if needed
      if (this.nextLabel >= this.maxElements) {
        this.index.resizeIndex(this.maxElements * 2);
        this.maxElements *= 2;
      }
      const label = this.nextLabel++;
      this.index.addPoint(vector, label);
      this.idMap.set(id, label);
      this.labelMap.set(label, id);
    }
    this.saveMeta();
  }

  remove(id: string): void {
    if (!this.index) throw new Error('VectorIndex not initialized');
    const label = this.idMap.get(id);
    if (label !== undefined) {
      this.index.markDelete(label);
      this.idMap.delete(id);
      this.labelMap.delete(label);
      this.saveMeta();
    }
  }

  search(vector: number[], topK: number): Array<{ id: string; score: number }> {
    if (!this.index) throw new Error('VectorIndex not initialized');
    if (this.idMap.size === 0) return [];

    const k = Math.min(topK, this.idMap.size);
    const result = this.index.searchKnn(vector, k);
    const items: Array<{ id: string; score: number }> = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const externalId = this.labelMap.get(label);
      if (externalId) {
        // hnswlib cosine distance = 1 - cosine_similarity
        items.push({ id: externalId, score: 1 - result.distances[i] });
      }
    }
    return items;
  }

  getSize(): number {
    return this.idMap.size;
  }

  getIndexFileSize(): number {
    try {
      return fs.existsSync(this.indexPath) ? fs.statSync(this.indexPath).size : 0;
    } catch {
      return 0;
    }
  }

  private saveMeta(): void {
    const meta: IndexMeta = {
      idMap: Object.fromEntries(this.idMap),
      labelMap: Object.fromEntries(this.labelMap),
      nextLabel: this.nextLabel,
    };
    fs.writeFileSync(this.metaPath, JSON.stringify(meta));
  }

  save(): void {
    if (!this.index) return;
    this.index.writeIndexSync(this.indexPath);
    this.saveMeta();
  }

  close(): void {
    if (this.index) {
      this.save();
      this.index = null;
    }
  }
}

// Internal typings for hnswlib-node
interface HnswIndex {
  initIndex(maxElements: number): void;
  readIndexSync(path: string): void;
  writeIndexSync(path: string): void;
  addPoint(vector: number[], label: number): void;
  markDelete(label: number): void;
  searchKnn(vector: number[], k: number): { neighbors: number[]; distances: number[] };
  resizeIndex(newSize: number): void;
}

interface IndexMeta {
  idMap: Record<string, number>;
  labelMap: Record<number, string>;
  nextLabel: number;
}
