import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export class SnapshotRecordError extends Error {
  constructor(message, { code = 'invalid_snapshot_record', lineNumber = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SnapshotRecordError';
    this.code = code;
    this.lineNumber = lineNumber;
  }
}

// Future bulk-source parsers can yield canonical candidate objects or SnapshotRecordError values.
export async function* readNdjsonSnapshot(path) {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      yield new SnapshotRecordError(`Invalid JSON on line ${lineNumber}`, { code: 'invalid_json', lineNumber, cause: error });
    }
  }
}
