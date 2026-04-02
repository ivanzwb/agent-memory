import * as fs from 'fs';
import * as path from 'path';

/**
 * Simple append-only audit logger.
 * Writes one JSON line per event to {dataDir}/audit.log
 */
export class AuditLogger {
  private logPath: string;
  private stream: fs.WriteStream;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.logPath = path.join(dataDir, 'audit.log');
    this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
  }

  log(event: AuditEvent): void {
    const entry = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.stream.write(JSON.stringify(entry) + '\n');
  }

  close(): void {
    this.stream.end();
  }
}

export interface AuditEvent {
  action: 'append_message' | 'save_memory' | 'delete_memory' | 'archive' | 'purge' | 'import' | 'export' | 'maintenance';
  targetId?: string | number;
  details?: string;
}
