import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getCanonicalCandidates } from './canonical-source.js';
import { buildOpenLibraryAuthorIndex, createOpenLibraryAuthorLookup, readOpenLibraryEditionCandidates } from './open-library-bulk.js';
import { buildSnapshotIndex, createLocalCanonicalAdapter } from './snapshot-index.js';
import { SnapshotRecordError } from './snapshot-reader.js';

async function byteSize(path) {
  let total = 0;
  async function visit(current) {
    const stats = await fs.stat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stats) return;
    if (stats.isFile()) { total += stats.size; return; }
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!entries) return;
    for (const entry of entries) await visit(join(current, entry.name));
  }
  await visit(path);
  return total;
}

function millisecondsSince(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function validChunkSize(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('sortChunkSize must be a positive integer');
  return value;
}

function sourceFor(candidate, exact = false) {
  return {
    key: `bulk-smoke-${candidate.recordId.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase()}`,
    title: candidate.title,
    author: candidate.authors[0],
    ...(exact ? { preferredIsbn13: candidate.isbn13 } : {}),
  };
}

async function firstCandidates({ editionsPath, snapshotId, authorLookup, limit = 3 }) {
  const candidates = [];
  for await (const value of readOpenLibraryEditionCandidates({ inputPath: editionsPath, snapshotId, authorLookup })) {
    if (!(value instanceof SnapshotRecordError)) candidates.push(value);
    if (candidates.length === limit) break;
  }
  return candidates;
}

function createObserver(directory) {
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;
  let peakWorkspaceBytes = 0;
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const memory = process.memoryUsage();
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
      peakWorkspaceBytes = Math.max(peakWorkspaceBytes, await byteSize(directory));
    } finally { sampling = false; }
  };
  return {
    sample,
    get result() { return { peakRssBytes, peakHeapUsedBytes, peakWorkspaceBytes }; },
  };
}

export async function runOpenLibraryBulkSmoke({
  authorsPath,
  editionsPath,
  workingDirectory,
  snapshotId,
  sortChunkSize = 10_000,
  maxOpenRuns = 32,
}) {
  if (!authorsPath || !editionsPath || !workingDirectory || !snapshotId) throw new TypeError('authorsPath, editionsPath, workingDirectory and snapshotId are required');
  sortChunkSize = validChunkSize(sortChunkSize);
  authorsPath = resolve(authorsPath);
  editionsPath = resolve(editionsPath);
  workingDirectory = resolve(workingDirectory);
  const root = await fs.mkdtemp(join(workingDirectory, 'bookish-ol-smoke-'));
  const observer = createObserver(root);
  const timer = setInterval(() => { void observer.sample(); }, 250);
  timer.unref();
  const sortOptions = { sortChunkSize, maxOpenRuns, onSortRun: () => { void observer.sample(); } };
  try {
    await observer.sample();
    const authorStart = process.hrtime.bigint();
    const authorPath = join(root, 'authors');
    const author = await buildOpenLibraryAuthorIndex({ inputPath: authorsPath, outputPath: authorPath, snapshotId, ...sortOptions });
    await observer.sample();
    const authorMetrics = { inputBytes: (await fs.stat(authorsPath)).size, indexBytes: await byteSize(authorPath), elapsedMs: millisecondsSince(authorStart), statistics: author.statistics };

    const lookup = await createOpenLibraryAuthorLookup({ indexPath: authorPath, snapshotId });
    const editionStart = process.hrtime.bigint();
    const editionPath = join(root, 'editions');
    const edition = await buildSnapshotIndex({
      records: readOpenLibraryEditionCandidates({ inputPath: editionsPath, snapshotId, authorLookup: lookup }),
      outputPath: editionPath,
      sourceName: 'open-library-bulk',
      snapshotId,
      ...sortOptions,
    });
    await observer.sample();
    const editionMetrics = { inputBytes: (await fs.stat(editionsPath)).size, indexBytes: await byteSize(editionPath), elapsedMs: millisecondsSince(editionStart), statistics: edition.statistics };

    const adapter = await createLocalCanonicalAdapter({ indexPath: editionPath });
    const probes = await firstCandidates({ editionsPath, snapshotId, authorLookup: lookup });
    if (!probes.length) throw new Error('No canonical candidates were produced from the supplied matching samples');
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => { throw new Error('Lookup unexpectedly attempted network access'); };
      const lookups = [];
      for (const candidate of probes) {
        const exact = await getCanonicalCandidates(adapter, sourceFor(candidate, true));
        const titleAuthor = await getCanonicalCandidates(adapter, sourceFor(candidate));
        const repeated = await getCanonicalCandidates(adapter, sourceFor(candidate));
        if (!exact.some(value => value.isbn13 === candidate.isbn13)) throw new Error(`Exact ISBN lookup failed for ${candidate.isbn13}`);
        if (JSON.stringify(titleAuthor) !== JSON.stringify(repeated)) throw new Error(`Candidate ordering was not deterministic for ${candidate.recordId}`);
        if (titleAuthor.some(value => value.sourceName !== 'open-library-bulk' || value.snapshotId !== snapshotId)) throw new Error(`Candidate provenance was invalid for ${candidate.recordId}`);
        lookups.push({ isbn13: candidate.isbn13, title: candidate.title, author: candidate.authors[0], exactCount: exact.length, titleAuthorCount: titleAuthor.length });
      }
      return { root, author: authorMetrics, edition: editionMetrics, lookups, observation: observer.result };
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    clearInterval(timer);
    await observer.sample();
    await fs.rm(root, { recursive: true, force: true });
  }
}
