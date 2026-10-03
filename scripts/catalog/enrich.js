import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { CatalogContractError } from './contracts.js';
import { validateDiscoverArtifact } from './discover.js';
import { stableJson } from './external-sort.js';
import { normalizeIsbn13 } from './normalize.js';
import {
  createOpenLibraryAuthorLookup,
  isbn13Values,
  readAuthorIndexMetadata,
  readOpenLibraryBulkRecords,
} from './open-library-bulk.js';
import { SnapshotRecordError } from './snapshot-reader.js';

export const CATALOG_ENRICH_MAX_ISBNS = 50;
export const CATALOG_ENRICH_DEFAULT_PROGRESS_INTERVAL = 500_000;

const ENRICHED_CANDIDATE_KEYS = Object.freeze([
  'workKey',
  'title',
  'authorKeys',
  'coverIds',
  'score',
  'signals',
  'isbns',
  'primaryAuthor',
]);
const NO_MATCHES = [];

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_argument', `${name} must be a positive integer`);
  return value;
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_argument', `${name} is required`);
  return resolve(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail('invalid_enriched_artifact', `${label} is malformed`);
  }
}

async function assertReadable(path, label) {
  try {
    await fs.access(path);
  } catch (cause) {
    fail('invalid_argument', `Unable to read ${label} ${path}: ${cause.message}`);
  }
}

function bump(counts, field) {
  counts[field] += 1;
  if (!Number.isSafeInteger(counts[field])) fail('invalid_enriched_artifact', `${field} exceeded a safe integer`);
}

function progressSnapshot(counts) {
  return {
    rowsScanned: counts.rowsScanned,
    matchedEditions: counts.matchedEditions,
    worksWithIsbns: counts.worksWithIsbns,
    worksWithoutIsbns: counts.worksTotal - counts.worksWithIsbns,
    worksWithAuthor: counts.worksWithAuthor,
  };
}

function noteProgress(counts, progressInterval, onProgress) {
  if (typeof onProgress !== 'function' || counts.rowsScanned % progressInterval !== 0) return;
  onProgress(progressSnapshot(counts));
}

export async function readDiscoverArtifact(inputPath) {
  const resolved = resolve(inputPath);
  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch (cause) {
    throw new CatalogContractError('invalid_discover_artifact', `Unable to read discover input ${resolved}: ${cause.message}`);
  }
  return validateDiscoverArtifact(artifact);
}

function assertIsbnList(isbns) {
  if (!Array.isArray(isbns) || isbns.length > CATALOG_ENRICH_MAX_ISBNS) {
    fail('invalid_enriched_artifact', 'Enriched candidate ISBNs are malformed');
  }
  const seen = new Set();
  for (let index = 0; index < isbns.length; index += 1) {
    const isbn = isbns[index];
    let normalized;
    try { normalized = normalizeIsbn13(isbn); }
    catch { fail('invalid_enriched_artifact', 'Enriched candidate ISBN is invalid'); }
    if (normalized !== isbn || seen.has(isbn) || (index > 0 && isbn <= isbns[index - 1])) {
      fail('invalid_enriched_artifact', 'Enriched candidate ISBNs must be unique sorted ISBN-13 values');
    }
    seen.add(isbn);
  }
}

function assertPrimaryAuthor(value) {
  if (value === null) return;
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_enriched_artifact', 'Enriched candidate primaryAuthor must be a name or null');
  }
}

export function validateEnrichedArtifact(value, { snapshotId } = {}) {
  if (!plainObject(value)) fail('invalid_enriched_artifact', 'Enriched artifact must be an object');
  if (snapshotId !== undefined && value.snapshotId !== snapshotId) {
    fail('invalid_enriched_artifact', 'Enriched artifact snapshotId does not match the input snapshot');
  }
  if (!Array.isArray(value.candidates)) fail('invalid_enriched_artifact', 'Enriched artifact candidates must be an array');
  const strippedCandidates = value.candidates.map(candidate => {
    if (!plainObject(candidate)) fail('invalid_enriched_artifact', 'Enriched candidate is malformed');
    exactKeys(candidate, ENRICHED_CANDIDATE_KEYS, 'Enriched candidate');
    assertIsbnList(candidate.isbns);
    assertPrimaryAuthor(candidate.primaryAuthor);
    const { isbns: _isbns, primaryAuthor: _primaryAuthor, ...core } = candidate;
    return core;
  });
  validateDiscoverArtifact({ ...value, candidates: strippedCandidates });
  return value;
}

export async function writeEnrichedArtifactAtomically(outputPath, artifact, { snapshotId } = {}) {
  const serialized = `${stableJson(artifact)}\n`;
  await writeFileAtomic(outputPath, serialized, {
    mode: 0o644,
    validate: async content => {
      let parsed;
      try { parsed = JSON.parse(content); }
      catch { fail('invalid_enriched_artifact', 'Enriched artifact is not valid JSON'); }
      validateEnrichedArtifact(parsed, { snapshotId });
      if (stableJson(parsed) !== stableJson(artifact)) fail('invalid_enriched_artifact', 'Enriched artifact did not round-trip');
    },
  });
}

function candidateEntries(candidates) {
  const entries = new Map();
  for (const candidate of candidates) {
    entries.set(candidate.workKey, { isbns: new Set(), primaryAuthor: null });
  }
  return entries;
}

function matchingWorkKeys(data, entries) {
  if (!Array.isArray(data.works)) return NO_MATCHES;
  let matched = null;
  for (const item of data.works) {
    const key = text(item?.key);
    if (!key || !entries.has(key)) continue;
    if (!matched) matched = [];
    if (!matched.includes(key)) matched.push(key);
  }
  return matched ?? NO_MATCHES;
}

function addIsbns(entry, isbns, counts) {
  for (const isbn of isbns) {
    if (entry.isbns.size >= CATALOG_ENRICH_MAX_ISBNS) return;
    const before = entry.isbns.size;
    entry.isbns.add(isbn);
    if (before === 0 && entry.isbns.size === 1) bump(counts, 'worksWithIsbns');
  }
}

async function assignPrimaryAuthors(entries, candidates, authorLookup) {
  const keys = [];
  for (const candidate of candidates) {
    const key = candidate.authorKeys[0];
    if (typeof key === 'string' && key) keys.push(key);
  }
  const names = keys.length ? await authorLookup.getNames(keys) : new Map();
  let worksWithAuthor = 0;
  for (const candidate of candidates) {
    const entry = entries.get(candidate.workKey);
    const name = names.get(candidate.authorKeys[0]);
    entry.primaryAuthor = typeof name === 'string' && name.trim() ? name : null;
    if (entry.primaryAuthor) worksWithAuthor += 1;
  }
  return worksWithAuthor;
}

// Stream edition rows with the bulk reader shared by the works index.
// Only candidate work keys stay in memory; dump rows are discarded after each yield.
async function scanEditions(editionsPath, entries, counts, progressInterval, onProgress) {
  for await (const record of readOpenLibraryBulkRecords(editionsPath)) {
    bump(counts, 'rowsScanned');
    try {
      if (record instanceof SnapshotRecordError || record?.type !== '/type/edition' || !plainObject(record.data)) continue;
      const matched = matchingWorkKeys(record.data, entries);
      if (!matched.length) continue;
      bump(counts, 'matchedEditions');
      const isbns = isbn13Values(record.data).values;
      for (const workKey of matched) addIsbns(entries.get(workKey), isbns, counts);
    } finally {
      noteProgress(counts, progressInterval, onProgress);
    }
  }
}

function enrichedArtifact(artifact, entries) {
  return {
    format: artifact.format,
    version: artifact.version,
    snapshotId: artifact.snapshotId,
    generatedAt: artifact.generatedAt,
    languageCheck: artifact.languageCheck,
    scoring: artifact.scoring,
    counts: artifact.counts,
    candidates: artifact.candidates.map(candidate => {
      const entry = entries.get(candidate.workKey);
      return {
        ...candidate,
        isbns: [...entry.isbns].sort(),
        primaryAuthor: entry.primaryAuthor,
      };
    }),
  };
}

export async function enrichCatalogCandidates({
  inputPath,
  editionsPath,
  authorsIndexPath,
  outputPath,
  progressInterval = CATALOG_ENRICH_DEFAULT_PROGRESS_INTERVAL,
  onProgress = null,
} = {}) {
  progressInterval = positiveInteger(progressInterval, 'progressInterval');
  if (onProgress !== null && typeof onProgress !== 'function') fail('invalid_argument', 'onProgress must be a function');
  const input = requiredPath(inputPath, 'inputPath');
  const editions = requiredPath(editionsPath, 'editionsPath');
  const authorsIndex = requiredPath(authorsIndexPath, 'authorsIndexPath');
  const output = requiredPath(outputPath, 'outputPath');
  await assertReadable(input, 'discover input');
  await assertReadable(editions, 'editions dump');
  await assertReadable(authorsIndex, 'author index');

  const artifact = await readDiscoverArtifact(input);
  const snapshotId = artifact.snapshotId;
  const authorMetadata = await readAuthorIndexMetadata(authorsIndex);
  if (authorMetadata.snapshotId !== snapshotId) {
    fail('author_snapshot_mismatch', 'Author index snapshotId does not match the discover artifact');
  }

  const entries = candidateEntries(artifact.candidates);
  const counts = {
    rowsScanned: 0,
    matchedEditions: 0,
    worksWithIsbns: 0,
    worksTotal: entries.size,
    worksWithAuthor: 0,
  };
  const authorLookup = await createOpenLibraryAuthorLookup({ indexPath: authorsIndex, snapshotId });
  try {
    counts.worksWithAuthor = await assignPrimaryAuthors(entries, artifact.candidates, authorLookup);
    await scanEditions(editions, entries, counts, progressInterval, onProgress);
    if (typeof onProgress === 'function') onProgress(progressSnapshot(counts));
    const enriched = enrichedArtifact(artifact, entries);
    validateEnrichedArtifact(enriched, { snapshotId });
    await writeEnrichedArtifactAtomically(output, enriched, { snapshotId });
    const summary = progressSnapshot(counts);
    return { ...summary, snapshotId, outputPath: output, artifact: enriched };
  } finally {
    if (typeof authorLookup.close === 'function') authorLookup.close();
  }
}
