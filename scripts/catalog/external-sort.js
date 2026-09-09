import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';

export const DEFAULT_SORT_CHUNK_SIZE = 10_000;
export const DEFAULT_MAX_OPEN_RUNS = 32;
export const DEFAULT_WRITE_BUFFER_BYTES = 64 * 1024;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function* readNdjson(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try { yield JSON.parse(line); }
    catch (error) { throw new Error(`Invalid NDJSON at ${path}:${lineNumber}`, { cause: error }); }
  }
}

async function exists(path) {
  try { await fs.access(path); return true; }
  catch { return false; }
}

async function writeRun(path, values) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${values.map(stableJson).join('\n')}\n`, 'utf8');
}

async function mergeRuns(paths, outputPath, compare) {
  const iterators = paths.map(path => readNdjson(path)[Symbol.asyncIterator]());
  const heads = await Promise.all(iterators.map(iterator => iterator.next()));
  await fs.mkdir(dirname(outputPath), { recursive: true });
  const output = await fs.open(outputPath, 'w');
  let buffer = '';
  const flush = async () => {
    if (!buffer) return;
    await output.writeFile(buffer, 'utf8');
    buffer = '';
  };
  try {
    while (true) {
      let selected = -1;
      for (let index = 0; index < heads.length; index++) {
        if (heads[index].done) continue;
        if (selected === -1 || compare(heads[index].value, heads[selected].value) < 0 || (compare(heads[index].value, heads[selected].value) === 0 && index < selected)) selected = index;
      }
      if (selected === -1) break;
      buffer += `${stableJson(heads[selected].value)}\n`;
      if (buffer.length >= DEFAULT_WRITE_BUFFER_BYTES) await flush();
      heads[selected] = await iterators[selected].next();
    }
    await flush();
  } finally {
    await output.close();
    await Promise.all(iterators.map(iterator => iterator.return?.()));
  }
}

export async function externalSortNdjson({ inputPath, outputPath, compare, runDirectory, chunkSize = DEFAULT_SORT_CHUNK_SIZE, maxOpenRuns = DEFAULT_MAX_OPEN_RUNS, onRun = null }) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer');
  if (!Number.isSafeInteger(maxOpenRuns) || maxOpenRuns < 2) throw new Error('maxOpenRuns must be at least 2');
  if (!(await exists(inputPath))) return { runsCreated: 0, mergePasses: 0 };
  const runs = [];
  let chunk = [];
  let runNumber = 0;
  let mergePasses = 0;
  const emit = event => onRun?.(event);
  const flush = async () => {
    if (!chunk.length) return;
    chunk.sort(compare);
    const path = join(runDirectory, `run-${String(runNumber++).padStart(8, '0')}.ndjson`);
    await writeRun(path, chunk);
    runs.push(path);
    emit({ type: 'created', path });
    chunk = [];
  };
  try {
    for await (const value of readNdjson(inputPath)) {
      chunk.push(value);
      if (chunk.length >= chunkSize) await flush();
    }
    await flush();
    if (!runs.length) return { runsCreated: 0, mergePasses: 0 };
    let current = runs;
    while (current.length > 1) {
      const next = [];
      for (let index = 0; index < current.length; index += maxOpenRuns) {
        const group = current.slice(index, index + maxOpenRuns);
        const merged = join(runDirectory, `merge-${mergePasses}-${String(next.length).padStart(8, '0')}.ndjson`);
        await mergeRuns(group, merged, compare);
        await Promise.all(group.map(path => fs.rm(path, { force: true })));
        next.push(merged);
        emit({ type: 'merged', path: merged, inputs: group.length });
      }
      current = next;
      mergePasses += 1;
    }
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.rename(current[0], outputPath);
    return { runsCreated: runs.length, mergePasses };
  } finally {
    await fs.rm(runDirectory, { recursive: true, force: true });
  }
}
