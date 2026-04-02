/** Base error for all memory operations */
export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

/** Thrown when calling methods on a closed instance */
export class MemoryClosedError extends MemoryError {
  constructor() {
    super('Memory instance has been closed');
    this.name = 'MemoryClosedError';
  }
}

/** Thrown when the specified memory ID does not exist */
export class MemoryNotFoundError extends MemoryError {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = 'MemoryNotFoundError';
  }
}

/** Thrown when a capacity limit is reached */
export class MemoryCapacityError extends MemoryError {
  constructor(limit: string, current: number, max: number) {
    super(`Capacity limit reached for ${limit}: ${current}/${max}`);
    this.name = 'MemoryCapacityError';
  }
}

/** Thrown when embedding generation fails */
export class EmbeddingError extends MemoryError {
  constructor(message: string) {
    super(`Embedding failed: ${message}`);
    this.name = 'EmbeddingError';
  }
}
