import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { CatalogContractError } from './contracts.js';
import { OPEN_LIBRARY_BULK_SOURCE, readOpenLibraryBulkRecords } from './open-library-bulk.js';
import { SnapshotRecordError } from './snapshot-reader.js';
import { stableJson } from './external-sort.js';

export const OPEN_LIBRARY_WORK_INDEX_VERSION = 1;
export const OPEN_LIBRARY_WORK_INDEX_FORMAT = 'bookish-open-library-work-index';

const WORK_INDEX_FILE = 'works.sqlite';
const DEFAULT_BATCH_SIZE = 10_000;
const DEFAULT_PROGRESS_INTERVAL = 500_000;
const WORK_KEY_PATTERN = /^\/works\/OL[0-9]+W$/;
const EDITION_KEY_PATTERN = /^\/books\/OL[0-9]+M$/;
const SIGNAL_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ABSENT_EDITION_KEY = '\\N';
const WORK_REJECTION_REASONS = ['malformed_row', 'invalid_json', 'wrong_type', 'missing_title'];
const RATING_REJECTION_REASONS = ['malformed_row', 'non_integer', 'out_of_range'];
const READING_LOG_REJECTION_REASONS = ['malformed_row', 'unknown_shelf'];

// Exact bookshelves.name values from ol_dump_reading-log_2026-08-31.
// "Stopped Reading" occurs in that dump and is rejected as an unknown shelf.
const READING_LOG_SHELVES = [
  ['Want to Read', 'want_to_read_count'],
  ['Currently Reading', 'currently_reading_count'],
  ['Already Read', 'already_read_count'],
];

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}

function description(value) {
  if (typeof value === 'string') return text(value);
  if (plainObject(value) && typeof value.value === 'string') return text(value.value);
  return null;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_argument', `${name} must be a positive integer`);
  return value;
}

function bump(object, key) {
  const value = object[key] + 1;
  if (!Number.isSafeInteger(value)) fail('invalid_work_index', `Statistic ${key} exceeded a safe integer`);
  object[key] = value;
}

function emptyStatistics() {
  return {
    works: {
      input: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      rejectedByReason: { malformed_row: 0, invalid_json: 0, wrong_type: 0, missing_title: 0 },
    },
    ratings: {
      input: 0,
      accepted: 0,
      rejected: 0,
      orphans: 0,
      rejectedByReason: { malformed_row: 0, non_integer: 0, out_of_range: 0 },
    },
    readingLog: {
      input: 0,
      accepted: 0,
      rejected: 0,
      orphans: 0,
      rejectedByReason: { malformed_row: 0, unknown_shelf: 0 },
    },
  };
}

function reject(section, reason) {
  bump(section, 'rejected');
  bump(section.rejectedByReason, reason);
}

function inputStream(path) {
  const source = createReadStream(path);
  if (!path.toLowerCase().endsWith('.gz')) return source;
  const gunzip = createGunzip();
  // pipe() does not forward source errors. A missing .gz otherwise crashes as an unhandled 'error'.
  source.on('error', error => gunzip.destroy(error));
  return source.pipe(gunzip);
}

async function assertReadableInput(inputPath) {
  try {
    await fs.access(inputPath);
  } catch (cause) {
    fail('invalid_argument', `Unable to read ${inputPath}: ${cause.message}`);
  }
}

async function* readSignalRows(path) {
  const lines = createInterface({ input: inputStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    yield line.split('\t').map(field => field.trim());
  }
}

function uniqueTexts(values, read) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const item = read(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function authorKeys(value) {
  return uniqueTexts(value, item => text(item?.author?.key));
}

function subjects(value) {
  return uniqueTexts(value, text);
}

function coverIds(value) {
  return uniqueTexts(value, item => (Number.isSafeInteger(item) && item > 0 ? item : null));
}

function parseRevision(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function signalShape(fields) {
  if (fields.length !== 4) return null;
  const [workKey, editionKey, value, date] = fields;
  if (!WORK_KEY_PATTERN.test(workKey)) return null;
  if (editionKey !== ABSENT_EDITION_KEY && !EDITION_KEY_PATTERN.test(editionKey)) return null;
  if (!SIGNAL_DATE_PATTERN.test(date)) return null;
  return { workKey, value };
}

function ratingValue(value) {
  if (!/^-?[0-9]+$/.test(value)) return { reason: 'non_integer' };
  const rating = Number(value);
  if (!Number.isSafeInteger(rating)) return { reason: 'non_integer' };
  if (rating < 1 || rating > 5) return { reason: 'out_of_range' };
  return { rating };
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function reasonCounts(value, reasons, label) {
  if (!plainObject(value) || !exactKeys(value, reasons)) fail('invalid_work_index', `${label} rejection reasons are malformed`);
  let total = 0;
  for (const reason of reasons) {
    if (!nonNegativeInteger(value[reason])) fail('invalid_work_index', `${label} rejection reason ${reason} is invalid`);
    total += value[reason];
  }
  return total;
}

function validateWorkIndexMetadata(value) {
  if (!plainObject(value) || !exactKeys(value, ['format', 'indexVersion', 'sourceName', 'snapshotId', 'generatedAt', 'statistics'])) {
    fail('invalid_work_index', 'Work index metadata is malformed');
  }
  if (value.format !== OPEN_LIBRARY_WORK_INDEX_FORMAT || value.indexVersion !== OPEN_LIBRARY_WORK_INDEX_VERSION || value.sourceName !== OPEN_LIBRARY_BULK_SOURCE) {
    fail('invalid_work_index', 'Work index metadata has an incompatible format, version, or source');
  }
  if (!text(value.snapshotId) || value.snapshotId !== text(value.snapshotId) || typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) {
    fail('invalid_work_index', 'Work index metadata is malformed');
  }
  const statistics = value.statistics;
  if (!plainObject(statistics) || !exactKeys(statistics, ['works', 'ratings', 'readingLog'])) fail('invalid_work_index', 'Work index statistics are malformed');
  const works = statistics.works;
  const ratings = statistics.ratings;
  const readingLog = statistics.readingLog;
  if (!plainObject(works) || !exactKeys(works, ['input', 'accepted', 'rejected', 'duplicates', 'rejectedByReason'])) fail('invalid_work_index', 'Work statistics are malformed');
  if (!plainObject(ratings) || !exactKeys(ratings, ['input', 'accepted', 'rejected', 'orphans', 'rejectedByReason'])) fail('invalid_work_index', 'Rating statistics are malformed');
  if (!plainObject(readingLog) || !exactKeys(readingLog, ['input', 'accepted', 'rejected', 'orphans', 'rejectedByReason'])) fail('invalid_work_index', 'Reading-log statistics are malformed');
  for (const field of ['input', 'accepted', 'rejected', 'duplicates']) if (!nonNegativeInteger(works[field])) fail('invalid_work_index', `works.${field} is invalid`);
  for (const section of [ratings, readingLog]) for (const field of ['input', 'accepted', 'rejected', 'orphans']) if (!nonNegativeInteger(section[field])) fail('invalid_work_index', 'Signal statistics are invalid');
  if (works.rejected !== reasonCounts(works.rejectedByReason, WORK_REJECTION_REASONS, 'works')) fail('invalid_work_index', 'Work rejection reasons do not match the rejected count');
  if (ratings.rejected !== reasonCounts(ratings.rejectedByReason, RATING_REJECTION_REASONS, 'ratings')) fail('invalid_work_index', 'Rating rejection reasons do not match the rejected count');
  if (readingLog.rejected !== reasonCounts(readingLog.rejectedByReason, READING_LOG_REJECTION_REASONS, 'reading-log')) fail('invalid_work_index', 'Reading-log rejection reasons do not match the rejected count');
  if (works.input !== works.accepted + works.rejected + works.duplicates) fail('invalid_work_index', 'Work input count does not match accepted, rejected, and duplicate counts');
  if (ratings.input !== ratings.accepted + ratings.rejected + ratings.orphans) fail('invalid_work_index', 'Rating input count does not match accepted, rejected, and orphan counts');
  if (readingLog.input !== readingLog.accepted + readingLog.rejected + readingLog.orphans) fail('invalid_work_index', 'Reading-log input count does not match accepted, rejected, and orphan counts');
  return value;
}

async function readWorkIndexMetadata(indexPath) {
  try {
    return validateWorkIndexMetadata(JSON.parse(await fs.readFile(join(indexPath, 'index.json'), 'utf8')));
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    throw new CatalogContractError('invalid_work_index', `Unable to read work index: ${cause.message}`);
  }
}

async function sqlite() {
  try { return await import('node:sqlite'); }
  catch (cause) {
    throw new CatalogContractError('sqlite_unavailable', `Open Library work index requires node:sqlite; run this catalog command with --experimental-sqlite (${cause.message})`);
  }
}

function parseStringList(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { fail('invalid_work_index', `${label} is not valid JSON`); }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item)) fail('invalid_work_index', `${label} is malformed`);
  return parsed;
}

function parseCoverList(value) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { fail('invalid_work_index', 'cover_ids is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.some(item => !Number.isSafeInteger(item) || item <= 0)) fail('invalid_work_index', 'cover_ids is malformed');
  return parsed;
}

function databaseMetadata(database) {
  const row = database.prepare(`
    SELECT index_format, index_version, source_name, snapshot_id, generated_at, statistics_json
      FROM metadata
     WHERE singleton = 1
  `).get();
  if (!row) fail('invalid_work_index', 'Work index metadata row is missing');
  let statistics;
  try { statistics = JSON.parse(row.statistics_json); }
  catch { fail('invalid_work_index', 'Work index statistics JSON is malformed'); }
  return validateWorkIndexMetadata({
    format: row.index_format,
    indexVersion: row.index_version,
    sourceName: row.source_name,
    snapshotId: row.snapshot_id,
    generatedAt: row.generated_at,
    statistics,
  });
}

function assertDatabaseMatches(database, metadata, { scanRows, progressInterval = 0, onProgress = null }) {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail('invalid_work_index', 'Work index failed SQLite integrity validation');
  const stored = databaseMetadata(database);
  if (stableJson(stored) !== stableJson(metadata)) fail('invalid_work_index', 'Work index SQLite metadata does not match index.json');
  const totals = database.prepare(`
    SELECT COUNT(*) AS works,
           COALESCE(SUM(ratings_count), 0) AS ratings,
           COALESCE(SUM(want_to_read_count + currently_reading_count + already_read_count), 0) AS reading_log
      FROM works
  `).get();
  if (totals.works !== metadata.statistics.works.accepted) fail('invalid_work_index', 'Work row count does not match metadata');
  if (totals.ratings !== metadata.statistics.ratings.accepted) fail('invalid_work_index', 'Rating counts do not match metadata');
  if (totals.reading_log !== metadata.statistics.readingLog.accepted) fail('invalid_work_index', 'Reading-log counts do not match metadata');
  if (!scanRows) return;
  if (typeof onProgress === 'function') onProgress(JSON.parse(stableJson(metadata.statistics)), 'validating');
  let works = 0;
  let ratings = 0;
  let readingLog = 0;
  const rows = database.prepare(`
    SELECT key, title, author_keys, subjects, cover_ids, ratings_count, ratings_sum,
           want_to_read_count, currently_reading_count, already_read_count
      FROM works
  `);
  for (const row of rows.iterate()) {
    // Keep `rows` referenced for the whole scan. node:sqlite finalizes an iterator
    // when its statement wrapper is collected, and a long scan otherwise fails
    // with "statement has been finalized".
    if (!rows) fail('invalid_work_index', 'Work scan lost its SQLite statement');
    works += 1;
    if (typeof row.key !== 'string' || !row.key || typeof row.title !== 'string' || !row.title) fail('invalid_work_index', 'Work row identity is malformed');
    parseStringList(row.author_keys, 'author_keys');
    parseStringList(row.subjects, 'subjects');
    parseCoverList(row.cover_ids);
    if (!nonNegativeInteger(row.ratings_count) || !nonNegativeInteger(row.ratings_sum) || row.ratings_sum < row.ratings_count || row.ratings_sum > row.ratings_count * 5) {
      fail('invalid_work_index', 'Work rating aggregate is malformed');
    }
    for (const count of [row.want_to_read_count, row.currently_reading_count, row.already_read_count]) {
      if (!nonNegativeInteger(count)) fail('invalid_work_index', 'Work reading-log aggregate is malformed');
    }
    ratings += row.ratings_count;
    readingLog += row.want_to_read_count + row.currently_reading_count + row.already_read_count;
    if (typeof onProgress === 'function' && progressInterval && works % progressInterval === 0) {
      onProgress(JSON.parse(stableJson(metadata.statistics)), 'validating');
    }
  }
  if (works !== metadata.statistics.works.accepted || ratings !== metadata.statistics.ratings.accepted || readingLog !== metadata.statistics.readingLog.accepted) {
    fail('invalid_work_index', 'Scanned work aggregates do not match metadata');
  }
}

function workRecord(row) {
  return {
    workKey: row.key,
    title: row.title,
    subtitle: row.subtitle,
    authorKeys: parseStringList(row.author_keys, 'author_keys'),
    subjects: parseStringList(row.subjects, 'subjects'),
    coverIds: parseCoverList(row.cover_ids),
    firstPublishDate: row.first_publish_date,
    description: row.description,
    ratingsCount: row.ratings_count,
    ratingsSum: row.ratings_sum,
    readingLog: {
      'Want to Read': row.want_to_read_count,
      'Currently Reading': row.currently_reading_count,
      'Already Read': row.already_read_count,
    },
  };
}

// Two renames, because a directory cannot atomically replace an existing directory.
// A crash after the existing output moves aside and before the temp directory takes its
// place leaves the previous artifact at the `.previous-*` path and the new tree at the temp path.
async function replaceDirectory(tempPath, outputPath) {
  const backup = `${outputPath}.previous-${process.pid}-${Date.now()}`;
  let moved = false;
  try { await fs.rename(outputPath, backup); moved = true; }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  try { await fs.rename(tempPath, outputPath); }
  catch (cause) {
    if (moved) await fs.rename(backup, outputPath).catch(() => {});
    throw cause;
  }
  if (moved) await fs.rm(backup, { recursive: true, force: true });
}

function noteProgress(statistics, progressInterval, onProgress, seen) {
  if (typeof onProgress !== 'function' || seen % progressInterval !== 0) return;
  onProgress(JSON.parse(stableJson(statistics)));
}

async function loadWorks({ database, worksPath, statistics, batch, progressInterval, onProgress, seen }) {
  const findWork = database.prepare('SELECT key FROM works WHERE key = ?');
  const upsertWork = database.prepare(`
    INSERT INTO works (
      key, revision, line_number, title, subtitle, author_keys, subjects, cover_ids,
      first_publish_date, description, ratings_count, ratings_sum,
      want_to_read_count, currently_reading_count, already_read_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)
    ON CONFLICT(key) DO UPDATE SET
      revision = excluded.revision,
      line_number = excluded.line_number,
      title = excluded.title,
      subtitle = excluded.subtitle,
      author_keys = excluded.author_keys,
      subjects = excluded.subjects,
      cover_ids = excluded.cover_ids,
      first_publish_date = excluded.first_publish_date,
      description = excluded.description
    WHERE excluded.revision > works.revision
       OR (excluded.revision = works.revision AND excluded.line_number > works.line_number)
  `);
  batch.begin();
  for await (const record of readOpenLibraryBulkRecords(worksPath)) {
    bump(statistics.works, 'input');
    seen.count += 1;
    try {
      if (record instanceof SnapshotRecordError) {
        reject(statistics.works, record.code === 'invalid_json' ? 'invalid_json' : 'malformed_row');
        continue;
      }
      if (record.type !== '/type/work') {
        reject(statistics.works, 'wrong_type');
        continue;
      }
      const key = text(record.key);
      const revision = parseRevision(record.revision);
      const lineNumber = record.lineNumber;
      if (!plainObject(record.data) || !key || !WORK_KEY_PATTERN.test(key) || revision === null || !Number.isSafeInteger(lineNumber)) {
        reject(statistics.works, 'malformed_row');
        continue;
      }
      const title = text(record.data.title);
      if (!title) {
        reject(statistics.works, 'missing_title');
        continue;
      }
      const existing = findWork.get(key);
      upsertWork.run(
        key,
        revision,
        lineNumber,
        title,
        text(record.data.subtitle),
        JSON.stringify(authorKeys(record.data.authors)),
        JSON.stringify(subjects(record.data.subjects)),
        JSON.stringify(coverIds(record.data.covers)),
        text(record.data.first_publish_date),
        description(record.data.description),
      );
      bump(statistics.works, existing ? 'duplicates' : 'accepted');
      batch.write();
    } finally {
      noteProgress(statistics, progressInterval, onProgress, seen.count);
    }
  }
  batch.commit();
}

async function loadRatings({ database, ratingsPath, statistics, batch, progressInterval, onProgress, seen }) {
  const upsertRating = database.prepare(`
    INSERT INTO works (
      key, revision, line_number, title, author_keys, subjects, cover_ids,
      ratings_count, ratings_sum, want_to_read_count, currently_reading_count, already_read_count
    )
    SELECT key, revision, line_number, title, author_keys, subjects, cover_ids,
           ratings_count + 1, ratings_sum + ?, want_to_read_count, currently_reading_count, already_read_count
      FROM works
     WHERE key = ?
    ON CONFLICT(key) DO UPDATE SET
      ratings_count = excluded.ratings_count,
      ratings_sum = excluded.ratings_sum
  `);
  batch.begin();
  for await (const fields of readSignalRows(ratingsPath)) {
    bump(statistics.ratings, 'input');
    seen.count += 1;
    try {
      const shape = signalShape(fields);
      if (!shape) {
        reject(statistics.ratings, 'malformed_row');
        continue;
      }
      const rating = ratingValue(shape.value);
      if (rating.reason) {
        reject(statistics.ratings, rating.reason);
        continue;
      }
      const info = upsertRating.run(rating.rating, shape.workKey);
      bump(statistics.ratings, info.changes > 0 ? 'accepted' : 'orphans');
      batch.write();
    } finally {
      noteProgress(statistics, progressInterval, onProgress, seen.count);
    }
  }
  batch.commit();
}

async function loadReadingLog({ database, readingLogPath, statistics, batch, progressInterval, onProgress, seen }) {
  const upserts = new Map(READING_LOG_SHELVES.map(([shelf, column]) => [shelf, database.prepare(`
    INSERT INTO works (
      key, revision, line_number, title, author_keys, subjects, cover_ids,
      ratings_count, ratings_sum, want_to_read_count, currently_reading_count, already_read_count
    )
    SELECT key, revision, line_number, title, author_keys, subjects, cover_ids,
           ratings_count, ratings_sum,
           want_to_read_count + ${column === 'want_to_read_count' ? 1 : 0},
           currently_reading_count + ${column === 'currently_reading_count' ? 1 : 0},
           already_read_count + ${column === 'already_read_count' ? 1 : 0}
      FROM works
     WHERE key = ?
    ON CONFLICT(key) DO UPDATE SET
      ${column} = excluded.${column}
  `)]));
  batch.begin();
  for await (const fields of readSignalRows(readingLogPath)) {
    bump(statistics.readingLog, 'input');
    seen.count += 1;
    try {
      const shape = signalShape(fields);
      if (!shape) {
        reject(statistics.readingLog, 'malformed_row');
        continue;
      }
      const upsert = upserts.get(shape.value);
      if (!upsert) {
        reject(statistics.readingLog, 'unknown_shelf');
        continue;
      }
      const info = upsert.run(shape.workKey);
      bump(statistics.readingLog, info.changes > 0 ? 'accepted' : 'orphans');
      batch.write();
    } finally {
      noteProgress(statistics, progressInterval, onProgress, seen.count);
    }
  }
  batch.commit();
}

export async function buildOpenLibraryWorkIndex({
  worksPath,
  ratingsPath,
  readingLogPath,
  outputPath,
  snapshotId,
  generatedAt = new Date().toISOString(),
  batchSize = DEFAULT_BATCH_SIZE,
  progressInterval = DEFAULT_PROGRESS_INTERVAL,
  onProgress = null,
}) {
  snapshotId = text(snapshotId);
  if (!snapshotId) fail('invalid_argument', 'snapshotId is required');
  if (!worksPath || !ratingsPath || !readingLogPath || !outputPath) fail('invalid_argument', 'worksPath, ratingsPath, readingLogPath, and outputPath are required');
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) fail('invalid_argument', 'generatedAt must be an ISO timestamp');
  batchSize = positiveInteger(batchSize, 'batchSize');
  progressInterval = positiveInteger(progressInterval, 'progressInterval');
  outputPath = resolve(outputPath);
  worksPath = resolve(worksPath);
  ratingsPath = resolve(ratingsPath);
  readingLogPath = resolve(readingLogPath);
  const tempPath = `${outputPath}.building-${process.pid}-${Date.now()}`;
  const statistics = emptyStatistics();
  const seen = { count: 0 };
  const { DatabaseSync } = await sqlite();
  let database = null;
  let transactionOpen = false;
  let pending = 0;
  const batch = {
    begin() {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      pending = 0;
    },
    write() {
      pending += 1;
      if (pending >= batchSize) {
        database.exec('COMMIT; BEGIN IMMEDIATE;');
        pending = 0;
      }
    },
    commit() {
      if (!transactionOpen) return;
      database.exec('COMMIT;');
      transactionOpen = false;
      pending = 0;
    },
  };
  try {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await assertReadableInput(worksPath);
    await assertReadableInput(ratingsPath);
    await assertReadableInput(readingLogPath);
    await fs.rm(tempPath, { recursive: true, force: true });
    await fs.mkdir(tempPath, { recursive: true });
    database = new DatabaseSync(join(tempPath, WORK_INDEX_FILE));
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -32768;
      PRAGMA locking_mode = EXCLUSIVE;
      CREATE TABLE metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        index_format TEXT NOT NULL,
        index_version INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        statistics_json TEXT NOT NULL
      );
      CREATE TABLE works (
        key TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        author_keys TEXT NOT NULL,
        subjects TEXT NOT NULL,
        cover_ids TEXT NOT NULL,
        first_publish_date TEXT,
        description TEXT,
        ratings_count INTEGER NOT NULL CHECK (ratings_count >= 0),
        ratings_sum INTEGER NOT NULL CHECK (ratings_sum >= 0),
        want_to_read_count INTEGER NOT NULL CHECK (want_to_read_count >= 0),
        currently_reading_count INTEGER NOT NULL CHECK (currently_reading_count >= 0),
        already_read_count INTEGER NOT NULL CHECK (already_read_count >= 0)
      ) WITHOUT ROWID;
      PRAGMA user_version = ${OPEN_LIBRARY_WORK_INDEX_VERSION};
    `);
    const phase = { database, statistics, batch, progressInterval, onProgress, seen };
    await loadWorks({ ...phase, worksPath });
    await loadRatings({ ...phase, ratingsPath });
    await loadReadingLog({ ...phase, readingLogPath });
    database.exec('PRAGMA locking_mode = NORMAL; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
    transactionOpen = true;
    database.prepare(`
      INSERT INTO metadata (
        singleton, index_format, index_version, source_name, snapshot_id, generated_at, statistics_json
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `).run(
      OPEN_LIBRARY_WORK_INDEX_FORMAT,
      OPEN_LIBRARY_WORK_INDEX_VERSION,
      OPEN_LIBRARY_BULK_SOURCE,
      snapshotId,
      generatedAt,
      stableJson(statistics),
    );
    database.exec('COMMIT;');
    transactionOpen = false;
    database.exec('PRAGMA optimize;');
    database.close();
    database = null;
    await fs.rm(join(tempPath, `${WORK_INDEX_FILE}-journal`), { force: true });
    await fs.rm(join(tempPath, `${WORK_INDEX_FILE}-wal`), { force: true });
    await fs.rm(join(tempPath, `${WORK_INDEX_FILE}-shm`), { force: true });
    const metadata = validateWorkIndexMetadata({
      format: OPEN_LIBRARY_WORK_INDEX_FORMAT,
      indexVersion: OPEN_LIBRARY_WORK_INDEX_VERSION,
      sourceName: OPEN_LIBRARY_BULK_SOURCE,
      snapshotId,
      generatedAt,
      statistics,
    });
    await fs.writeFile(join(tempPath, 'index.json'), `${stableJson(metadata)}\n`, 'utf8');
    const written = await readWorkIndexMetadata(tempPath);
    const { DatabaseSync: ReadDatabase } = await sqlite();
    const validationDatabase = new ReadDatabase(join(tempPath, WORK_INDEX_FILE), { readOnly: true });
    try { assertDatabaseMatches(validationDatabase, written, { scanRows: true, progressInterval, onProgress }); }
    finally { validationDatabase.close(); }
    await replaceDirectory(tempPath, outputPath);
    return { ...metadata, outputPath };
  } catch (cause) {
    if (database && transactionOpen) {
      // ROLLBACK is a no-op while journal_mode=OFF. The temp directory is removed below either way.
      try { database.exec('ROLLBACK;'); } catch { /* rollback is best-effort */ }
    }
    if (database) {
      try { database.close(); } catch { /* close is best-effort */ }
      database = null;
    }
    await fs.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    throw cause;
  }
}

export async function createOpenLibraryWorkLookup({ indexPath, snapshotId }) {
  const path = resolve(indexPath);
  const requestedSnapshotId = text(snapshotId);
  if (!requestedSnapshotId) fail('invalid_argument', 'snapshotId is required');
  const metadata = await readWorkIndexMetadata(path);
  if (metadata.snapshotId !== requestedSnapshotId) fail('work_snapshot_mismatch', 'Work index snapshotId does not match the requested snapshot');
  const { DatabaseSync } = await sqlite();
  let database;
  try {
    database = new DatabaseSync(join(path, WORK_INDEX_FILE), { readOnly: true });
    assertDatabaseMatches(database, metadata, { scanRows: false });
  } catch (cause) {
    if (database) {
      try { database.close(); } catch { /* close is best-effort */ }
    }
    if (cause instanceof CatalogContractError) throw cause;
    throw new CatalogContractError('invalid_work_index', `Unable to read work index: ${cause.message}`);
  }
  const query = database.prepare(`
    SELECT key, title, subtitle, author_keys, subjects, cover_ids, first_publish_date, description,
           ratings_count, ratings_sum, want_to_read_count, currently_reading_count, already_read_count
      FROM works
     WHERE key = ?
  `);
  const scan = database.prepare(`
    SELECT key, title, author_keys, cover_ids, ratings_count, ratings_sum,
           want_to_read_count, currently_reading_count, already_read_count
      FROM works
  `);
  let closed = false;
  return {
    get(workKey) {
      if (closed) fail('invalid_work_index', 'Work lookup is closed');
      const row = query.get(workKey);
      return row ? workRecord(row) : null;
    },
    forEachWork(visit) {
      if (closed) fail('invalid_work_index', 'Work lookup is closed');
      for (const row of scan.iterate()) {
        // Keep `scan` referenced for the whole scan. node:sqlite finalizes an iterator
        // when its statement wrapper is collected.
        visit(row);
      }
    },
    close() {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  };
}
