import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { CatalogContractError } from './contracts.js';
import { stableJson } from './external-sort.js';
import { createOpenLibraryWorkLookup } from './open-library-works.js';

export const CATALOG_DISCOVER_FORMAT = 'bookish-catalog-discover';
export const CATALOG_DISCOVER_VERSION = 1;

// Popularity score for one Open Library work. English is not an input.
//
//   readers  = want-to-read + currently-reading + already-read
//   bayesian = (ratingsSum + priorRatings * priorMean) / (ratingsCount + priorRatings)
//   score    = ratingWeight * bayesian + readerWeight * ln(1 + readers)
//
// The prior pulls sparse averages toward priorMean so a single 5-star rating
// cannot outrank a well-rated, widely shelved work. ln(1 + readers) grows
// slowly, so shelf count still matters without drowning the rating.
// Equal scores break ties by work key ascending.
//
// minRatings and minReaders are selection floors. They are not part of the score.
export const CATALOG_DISCOVER_SCORING = Object.freeze({
  priorRatings: 20,
  priorMean: 3.5,
  ratingWeight: 1,
  readerWeight: 1,
  minRatings: 0,
  minReaders: 0,
});

// A work is counted under the first matching reason and is not selected.
export const CATALOG_DISCOVER_FILTER_REASONS = Object.freeze([
  'invalid_work_key',
  'missing_title',
  'missing_cover',
  'excluded',
  'below_min_ratings',
  'below_min_readers',
]);

const WORK_INDEX_FILE = 'works.sqlite';
const WORK_KEY_PATTERN = /^\/works\/OL[0-9]+W$/;
const READING_LOG_FIELDS = [
  ['want_to_read_count', 'Want to Read'],
  ['currently_reading_count', 'Currently Reading'],
  ['already_read_count', 'Already Read'],
];

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_argument', `${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_argument', `${name} must be a non-negative integer`);
  return value;
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_argument', `${name} is required`);
  return resolve(value);
}

function requiredSnapshotId(value) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_argument', 'snapshotId is required');
  return value.trim();
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('invalid_argument', 'generatedAt must be an ISO timestamp');
  return value;
}

function sqlInteger(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_work_index', `${label} is invalid`);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_work_index', `${label} is invalid`);
  return value;
}

function parseJsonArray(value, label, validItem) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { fail('invalid_work_index', `${label} is not valid JSON`); }
  if (!Array.isArray(parsed) || parsed.some(item => !validItem(item))) fail('invalid_work_index', `${label} is malformed`);
  return parsed;
}

function emptyReasonCounts() {
  return {
    invalid_work_key: 0,
    missing_title: 0,
    missing_cover: 0,
    excluded: 0,
    below_min_ratings: 0,
    below_min_readers: 0,
  };
}

export function popularityScore({ ratingsCount, ratingsSum, readers }, scoring = CATALOG_DISCOVER_SCORING) {
  const ratings = sqlInteger(ratingsCount, 'ratingsCount');
  const sum = sqlInteger(ratingsSum, 'ratingsSum');
  const shelfCount = sqlInteger(readers, 'readers');
  if (sum < ratings || sum > ratings * 5) fail('invalid_work_index', 'ratingsSum is invalid');
  const priorRatings = scoring.priorRatings;
  const priorMean = scoring.priorMean;
  if (!Number.isSafeInteger(priorRatings) || priorRatings < 1) fail('invalid_argument', 'priorRatings must be a positive integer');
  if (typeof priorMean !== 'number' || !Number.isFinite(priorMean)) fail('invalid_argument', 'priorMean must be a finite number');
  if (typeof scoring.ratingWeight !== 'number' || !Number.isFinite(scoring.ratingWeight)) fail('invalid_argument', 'ratingWeight must be a finite number');
  if (typeof scoring.readerWeight !== 'number' || !Number.isFinite(scoring.readerWeight)) fail('invalid_argument', 'readerWeight must be a finite number');
  const bayesian = (sum + priorRatings * priorMean) / (ratings + priorRatings);
  const score = scoring.ratingWeight * bayesian + scoring.readerWeight * Math.log(1 + shelfCount);
  if (!Number.isFinite(score)) fail('invalid_work_index', 'Popularity score is not finite');
  return score;
}

function scoringConfig(minRatings, minReaders) {
  return {
    priorRatings: CATALOG_DISCOVER_SCORING.priorRatings,
    priorMean: CATALOG_DISCOVER_SCORING.priorMean,
    ratingWeight: CATALOG_DISCOVER_SCORING.ratingWeight,
    readerWeight: CATALOG_DISCOVER_SCORING.readerWeight,
    minRatings,
    minReaders,
  };
}

function worseThan(left, right) {
  if (left.score !== right.score) return left.score < right.score;
  return left.workKey > right.workKey;
}

function siftUp(heap, index) {
  let current = index;
  while (current > 0) {
    const parent = Math.floor((current - 1) / 2);
    if (!worseThan(heap[current], heap[parent])) return;
    [heap[current], heap[parent]] = [heap[parent], heap[current]];
    current = parent;
  }
}

function siftDown(heap, index) {
  let current = index;
  let left = current * 2 + 1;
  while (left < heap.length) {
    const right = left + 1;
    let worst = current;
    if (worseThan(heap[left], heap[worst])) worst = left;
    if (right < heap.length && worseThan(heap[right], heap[worst])) worst = right;
    if (worst === current) return;
    [heap[current], heap[worst]] = [heap[worst], heap[current]];
    current = worst;
    left = current * 2 + 1;
  }
}

// Min-heap of the best `limit` candidates, ordered so the worst retained row sits at index 0.
function considerCandidate(heap, candidate, limit) {
  if (heap.length < limit) {
    heap.push(candidate);
    siftUp(heap, heap.length - 1);
  } else if (worseThan(heap[0], candidate)) {
    heap[0] = candidate;
    siftDown(heap, 0);
  }
  if (heap.length > limit) fail('invalid_discover_artifact', 'Candidate selection exceeded the limit');
}

function byRank(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  if (left.workKey < right.workKey) return -1;
  if (left.workKey > right.workKey) return 1;
  return 0;
}

function readerTotal(row) {
  let readers = 0;
  for (const [column] of READING_LOG_FIELDS) {
    readers += sqlInteger(row[column], column);
  }
  if (!Number.isSafeInteger(readers)) fail('invalid_work_index', 'Work reading-log aggregate is malformed');
  return readers;
}

function readingLogSignals(row) {
  const readingLog = {};
  for (const [column, shelf] of READING_LOG_FIELDS) readingLog[shelf] = sqlInteger(row[column], column);
  return readingLog;
}

function rejectionReason(row, excluded, minRatings, minReaders) {
  if (typeof row.key !== 'string' || !WORK_KEY_PATTERN.test(row.key)) return 'invalid_work_key';
  if (typeof row.title !== 'string' || !row.title.trim()) return 'missing_title';
  const coverIds = parseJsonArray(row.cover_ids, 'cover_ids', item => Number.isSafeInteger(item) && item > 0);
  if (!coverIds.length) return 'missing_cover';
  if (excluded.has(row.key)) return 'excluded';
  const ratingsCount = sqlInteger(row.ratings_count, 'ratings_count');
  if (ratingsCount < minRatings) return 'below_min_ratings';
  if (readerTotal(row) < minReaders) return 'below_min_readers';
  return null;
}

function candidateFromRow(row) {
  const ratingsCount = sqlInteger(row.ratings_count, 'ratings_count');
  const ratingsSum = sqlInteger(row.ratings_sum, 'ratings_sum');
  const readingLog = readingLogSignals(row);
  const readers = readingLog['Want to Read'] + readingLog['Currently Reading'] + readingLog['Already Read'];
  return {
    workKey: row.key,
    title: row.title,
    authorKeys: parseJsonArray(row.author_keys, 'author_keys', item => typeof item === 'string' && item.length > 0),
    coverIds: parseJsonArray(row.cover_ids, 'cover_ids', item => Number.isSafeInteger(item) && item > 0),
    score: popularityScore({ ratingsCount, ratingsSum, readers }),
    signals: { ratingsCount, ratingsSum, readingLog },
  };
}

function selectCandidates(database, { limit, excluded, minRatings, minReaders }) {
  const filteredByReason = emptyReasonCounts();
  let considered = 0;
  let eligible = 0;
  const heap = [];
  const rows = database.prepare(`
    SELECT key, title, author_keys, cover_ids, ratings_count, ratings_sum,
           want_to_read_count, currently_reading_count, already_read_count
      FROM works
  `);
  for (const row of rows.iterate()) {
    // Keep `rows` referenced for the whole scan. node:sqlite finalizes an iterator
    // when its statement wrapper is collected.
    if (!rows) fail('invalid_work_index', 'Work scan lost its SQLite statement');
    considered += 1;
    if (!Number.isSafeInteger(considered)) fail('invalid_discover_artifact', 'Considered count exceeded a safe integer');
    const reason = rejectionReason(row, excluded, minRatings, minReaders);
    if (reason) {
      filteredByReason[reason] += 1;
      continue;
    }
    eligible += 1;
    considerCandidate(heap, candidateFromRow(row), limit);
  }
  const candidates = heap.slice().sort(byRank);
  return { considered, eligible, filteredByReason, candidates };
}

async function readExcludeKeys(path) {
  try {
    await fs.access(path);
  } catch (cause) {
    fail('invalid_argument', `Unable to read exclude keys ${path}: ${cause.message}`);
  }
  const excluded = new Set();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const key = line.replace(/^\uFEFF/, '').trim();
      if (!key) continue;
      if (!WORK_KEY_PATTERN.test(key)) {
        fail('invalid_argument', `Exclude key at ${path}:${lineNumber} must match /works/OL<digits>W`);
      }
      excluded.add(key);
    }
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    fail('invalid_argument', `Unable to read exclude keys ${path}: ${cause.message}`);
  } finally {
    lines.close();
  }
  return excluded;
}

async function openWorksDatabase(indexPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (cause) {
    throw new CatalogContractError('sqlite_unavailable', `Catalog discovery requires node:sqlite; run this catalog command with --experimental-sqlite (${cause.message})`);
  }
  try {
    return new DatabaseSync(join(indexPath, WORK_INDEX_FILE), { readOnly: true });
  } catch (cause) {
    throw new CatalogContractError('invalid_work_index', `Unable to read work index: ${cause.message}`);
  }
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail('invalid_discover_artifact', `${label} is malformed`);
  }
}

function signalReaders(readingLog) {
  let readers = 0;
  for (const shelf of ['Want to Read', 'Currently Reading', 'Already Read']) {
    readers += nonNegativeInteger(readingLog[shelf], shelf);
  }
  if (!Number.isSafeInteger(readers)) fail('invalid_discover_artifact', 'Candidate reading-log counts are malformed');
  return readers;
}

export function validateDiscoverArtifact(value, { snapshotId, limit } = {}) {
  if (!plainObject(value)) fail('invalid_discover_artifact', 'Discover artifact must be an object');
  exactKeys(value, ['format', 'version', 'snapshotId', 'generatedAt', 'languageCheck', 'scoring', 'counts', 'candidates'], 'Discover artifact');
  if (value.format !== CATALOG_DISCOVER_FORMAT || value.version !== CATALOG_DISCOVER_VERSION) {
    fail('invalid_discover_artifact', 'Discover artifact has an incompatible format or version');
  }
  if (typeof value.snapshotId !== 'string' || !value.snapshotId || (snapshotId !== undefined && value.snapshotId !== snapshotId)) {
    fail('invalid_discover_artifact', 'Discover artifact snapshotId does not match the requested snapshot');
  }
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) {
    fail('invalid_discover_artifact', 'Discover artifact generatedAt is malformed');
  }
  if (value.languageCheck !== 'pending') fail('invalid_discover_artifact', 'Discover artifact languageCheck must stay pending');
  if (!plainObject(value.scoring)) fail('invalid_discover_artifact', 'Discover artifact scoring config is malformed');
  exactKeys(value.scoring, ['priorRatings', 'priorMean', 'ratingWeight', 'readerWeight', 'minRatings', 'minReaders'], 'Discover scoring');
  for (const field of ['priorRatings', 'priorMean', 'ratingWeight', 'readerWeight']) {
    if (value.scoring[field] !== CATALOG_DISCOVER_SCORING[field]) fail('invalid_discover_artifact', `Discover scoring ${field} does not match the catalog config`);
  }
  nonNegativeInteger(value.scoring.minRatings, 'minRatings');
  nonNegativeInteger(value.scoring.minReaders, 'minReaders');
  if (!plainObject(value.counts)) fail('invalid_discover_artifact', 'Discover artifact counts are malformed');
  exactKeys(value.counts, ['considered', 'filteredByReason', 'eligible', 'selected'], 'Discover counts');
  nonNegativeInteger(value.counts.considered, 'considered');
  nonNegativeInteger(value.counts.eligible, 'eligible');
  nonNegativeInteger(value.counts.selected, 'selected');
  if (!plainObject(value.counts.filteredByReason)) fail('invalid_discover_artifact', 'Discover filter counts are malformed');
  exactKeys(value.counts.filteredByReason, CATALOG_DISCOVER_FILTER_REASONS, 'Discover filter counts');
  let filtered = 0;
  for (const reason of CATALOG_DISCOVER_FILTER_REASONS) {
    filtered += nonNegativeInteger(value.counts.filteredByReason[reason], reason);
  }
  if (!Number.isSafeInteger(filtered) || value.counts.considered !== filtered + value.counts.eligible) {
    fail('invalid_discover_artifact', 'Discover counts do not reconcile');
  }
  if (!Array.isArray(value.candidates) || value.candidates.length !== value.counts.selected) {
    fail('invalid_discover_artifact', 'Discover candidate list does not match the selected count');
  }
  if (value.counts.selected > value.counts.eligible) fail('invalid_discover_artifact', 'Discover selected more works than were eligible');
  if (limit !== undefined && value.counts.selected > limit) fail('invalid_discover_artifact', 'Discover candidate list exceeds the limit');
  const seen = new Set();
  for (let index = 0; index < value.candidates.length; index += 1) {
    const candidate = value.candidates[index];
    if (!plainObject(candidate)) fail('invalid_discover_artifact', 'Discover candidate is malformed');
    exactKeys(candidate, ['workKey', 'title', 'authorKeys', 'coverIds', 'score', 'signals'], 'Discover candidate');
    if (typeof candidate.workKey !== 'string' || !WORK_KEY_PATTERN.test(candidate.workKey) || seen.has(candidate.workKey)) {
      fail('invalid_discover_artifact', 'Discover candidate work key is invalid');
    }
    seen.add(candidate.workKey);
    if (typeof candidate.title !== 'string' || !candidate.title.trim()) fail('invalid_discover_artifact', 'Discover candidate title is empty');
    if (!Array.isArray(candidate.authorKeys) || candidate.authorKeys.some(item => typeof item !== 'string' || !item)) {
      fail('invalid_discover_artifact', 'Discover candidate author keys are malformed');
    }
    if (!Array.isArray(candidate.coverIds) || !candidate.coverIds.length || candidate.coverIds.some(item => !Number.isSafeInteger(item) || item <= 0)) {
      fail('invalid_discover_artifact', 'Discover candidate cover ids are malformed');
    }
    if (typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)) fail('invalid_discover_artifact', 'Discover candidate score is invalid');
    if (!plainObject(candidate.signals)) fail('invalid_discover_artifact', 'Discover candidate signals are malformed');
    exactKeys(candidate.signals, ['ratingsCount', 'ratingsSum', 'readingLog'], 'Discover candidate signals');
    if (!plainObject(candidate.signals.readingLog)) fail('invalid_discover_artifact', 'Discover candidate reading log is malformed');
    exactKeys(candidate.signals.readingLog, ['Want to Read', 'Currently Reading', 'Already Read'], 'Discover candidate reading log');
    const readers = signalReaders(candidate.signals.readingLog);
    const expected = popularityScore({
      ratingsCount: candidate.signals.ratingsCount,
      ratingsSum: candidate.signals.ratingsSum,
      readers,
    });
    if (candidate.score !== expected) fail('invalid_discover_artifact', 'Discover candidate score does not match its signals');
    if (index > 0 && byRank(value.candidates[index - 1], candidate) > 0) {
      fail('invalid_discover_artifact', 'Discover candidates are not ranked by score and work key');
    }
  }
  return value;
}

function assertMatchesLookup(lookup, candidates) {
  for (const candidate of candidates) {
    const stored = lookup.get(candidate.workKey);
    if (!stored) fail('invalid_work_index', `Selected work ${candidate.workKey} is missing from the works index`);
    if (stored.title !== candidate.title || stableJson(stored.authorKeys) !== stableJson(candidate.authorKeys) || stableJson(stored.coverIds) !== stableJson(candidate.coverIds)) {
      fail('invalid_work_index', `Selected work ${candidate.workKey} does not match the works index`);
    }
    if (stored.ratingsCount !== candidate.signals.ratingsCount || stored.ratingsSum !== candidate.signals.ratingsSum) {
      fail('invalid_work_index', `Selected work ${candidate.workKey} ratings do not match the works index`);
    }
    if (stableJson(stored.readingLog) !== stableJson(candidate.signals.readingLog)) {
      fail('invalid_work_index', `Selected work ${candidate.workKey} reading log does not match the works index`);
    }
  }
}

async function writeArtifactAtomically(outputPath, artifact, settings) {
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(dirname(outputPath), { recursive: true });
  try {
    await fs.writeFile(temporary, `${stableJson(artifact)}\n`, 'utf8');
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(temporary, 'utf8')); }
    catch { fail('invalid_discover_artifact', 'Discover artifact is not valid JSON'); }
    validateDiscoverArtifact(parsed, settings);
    if (stableJson(parsed) !== stableJson(artifact)) fail('invalid_discover_artifact', 'Discover artifact did not round-trip');
    await fs.rename(temporary, outputPath);
  } catch (cause) {
    await fs.rm(temporary, { force: true });
    throw cause;
  }
}

export async function discoverCatalogCandidates({
  worksIndexPath,
  snapshotId,
  limit,
  outputPath,
  minRatings = CATALOG_DISCOVER_SCORING.minRatings,
  minReaders = CATALOG_DISCOVER_SCORING.minReaders,
  excludeKeysPath = null,
  generatedAt = new Date().toISOString(),
}) {
  const settings = {
    worksIndexPath: requiredPath(worksIndexPath, 'worksIndexPath'),
    snapshotId: requiredSnapshotId(snapshotId),
    limit: positiveInteger(limit, 'limit'),
    outputPath: requiredPath(outputPath, 'outputPath'),
    minRatings: nonNegativeInteger(minRatings, 'minRatings'),
    minReaders: nonNegativeInteger(minReaders, 'minReaders'),
    generatedAt: requiredTimestamp(generatedAt),
  };
  const excluded = excludeKeysPath ? await readExcludeKeys(requiredPath(excludeKeysPath, 'excludeKeysPath')) : new Set();
  const lookup = await createOpenLibraryWorkLookup({ indexPath: settings.worksIndexPath, snapshotId: settings.snapshotId });
  let database = null;
  try {
    database = await openWorksDatabase(settings.worksIndexPath);
    const selection = selectCandidates(database, { ...settings, excluded });
    assertMatchesLookup(lookup, selection.candidates);
    const artifact = {
      format: CATALOG_DISCOVER_FORMAT,
      version: CATALOG_DISCOVER_VERSION,
      snapshotId: settings.snapshotId,
      generatedAt: settings.generatedAt,
      languageCheck: 'pending',
      scoring: scoringConfig(settings.minRatings, settings.minReaders),
      counts: {
        considered: selection.considered,
        filteredByReason: selection.filteredByReason,
        eligible: selection.eligible,
        selected: selection.candidates.length,
      },
      candidates: selection.candidates,
    };
    validateDiscoverArtifact(artifact, settings);
    await writeArtifactAtomically(settings.outputPath, artifact, settings);
    return { ...artifact, outputPath: settings.outputPath };
  } finally {
    if (database) {
      try { database.close(); } catch { /* close is best-effort */ }
    }
    lookup.close();
  }
}
