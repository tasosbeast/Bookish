import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { CatalogContractError } from './contracts.js';
import { validateCanonicalCandidate } from './canonical-source.js';
import { normalizeIsbn10ToIsbn13, normalizeIsbn13 } from './normalize.js';
import { selectEditionPublicationYear } from './resolve.js';
import { SnapshotRecordError } from './snapshot-reader.js';
import { DEFAULT_MAX_OPEN_RUNS, DEFAULT_SORT_CHUNK_SIZE, DEFAULT_WRITE_BUFFER_BYTES, externalSortNdjson, readNdjson, stableJson } from './external-sort.js';

export const OPEN_LIBRARY_BULK_SOURCE = 'open-library-bulk';
export const OPEN_LIBRARY_AUTHOR_INDEX_VERSION = 2;
export const OPEN_LIBRARY_AUTHOR_LOOKUP_VERSION = 1;
const AUTHOR_INDEX_FORMAT = 'bookish-open-library-author-index';
const AUTHOR_LOOKUP_FORMAT = 'bookish-open-library-author-lookup';
const AUTHOR_SHARD_COUNT = 64;
const AUTHOR_LOOKUP_FILE = 'lookup.sqlite';
const AUTHOR_LOOKUP_BATCH_SIZE = 50_000;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function shardFor(value) {
  return Number.parseInt(hash(value).slice(0, 8), 16) % AUTHOR_SHARD_COUNT;
}

function shardName(shard) {
  return `${String(shard).padStart(2, '0')}.ndjson`;
}

function dumpColumns(line) {
  const tabs = [];
  for (let index = 0; index < line.length && tabs.length < 4; index++) if (line[index] === '\t') tabs.push(index);
  if (tabs.length !== 4) return null;
  return {
    type: line.slice(0, tabs[0]),
    key: line.slice(tabs[0] + 1, tabs[1]),
    revision: line.slice(tabs[1] + 1, tabs[2]),
    lastModified: line.slice(tabs[2] + 1, tabs[3]),
    payload: line.slice(tabs[3] + 1),
  };
}

function inputStream(path) {
  const source = createReadStream(path);
  return path.toLowerCase().endsWith('.gz') ? source.pipe(createGunzip()) : source;
}

// Actual Open Library dumps are tab-separated: type, key, revision, timestamp, JSON payload.
export async function* readOpenLibraryBulkRecords(path) {
  const lines = createInterface({ input: inputStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    const columns = dumpColumns(line);
    if (!columns) {
      yield new SnapshotRecordError(`Malformed Open Library row ${lineNumber}`, { code: 'malformed_dump_row', lineNumber });
      continue;
    }
    try {
      yield { ...columns, data: JSON.parse(columns.payload), lineNumber };
    } catch (error) {
      yield new SnapshotRecordError(`Invalid JSON on Open Library row ${lineNumber}`, { code: 'invalid_json', lineNumber, cause: error });
    }
  }
}

function referenceKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item?.key)).filter(Boolean))];
}

function firstText(value) {
  if (Array.isArray(value)) return value.map(text).find(Boolean) ?? null;
  return text(value);
}

function normalizeLanguage(value) {
  const language = text(value?.key ?? value);
  if (!language) return null;
  const code = language.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? null;
  if (!code) return null;
  if (code === 'eng' || code === 'en') return 'en';
  return code;
}

function editionLanguage(languages) {
  const values = [...new Set((Array.isArray(languages) ? languages : []).map(normalizeLanguage).filter(Boolean))];
  return values.includes('en') ? 'en' : values[0] ?? null;
}

function normalizeFormat(value) {
  const format = text(value);
  if (!format) return null;
  const folded = format.toLowerCase();
  if (/audio|audiobook|sound recording|compact disc/.test(folded)) return 'audiobook';
  if (/paperback|softcover|soft cover/.test(folded)) return 'paperback';
  if (/hardback|hardcover|hard cover/.test(folded)) return 'hardcover';
  return format;
}

function description(value) {
  if (typeof value === 'string') return text(value);
  if (plainObject(value) && typeof value.value === 'string') return text(value.value);
  return null;
}

function cover(value) {
  if (!Array.isArray(value)) return null;
  const id = value.find(item => Number.isSafeInteger(item) && item > 0);
  return id ? { url: null, reference: `open_library_cover_id:${id}` } : null;
}

function publicationYear(data) {
  // first_publish_year is work-level metadata and is intentionally ignored.
  return selectEditionPublicationYear({ publicationDates: [data.publish_date ?? data.publication_date], publicationYears: [] });
}

function isbn13Values(data) {
  const valid = new Set();
  let invalid = 0;
  for (const value of Array.isArray(data.isbn_13) ? data.isbn_13 : []) {
    try { valid.add(normalizeIsbn13(value)); }
    catch { invalid += 1; }
  }
  for (const value of Array.isArray(data.isbn_10) ? data.isbn_10 : []) {
    try { valid.add(normalizeIsbn10ToIsbn13(value)); }
    catch { invalid += 1; }
  }
  return { values: [...valid].sort(), invalid };
}

function sourceIdentifiers(record, workKeys, authorKeys) {
  const identifiers = { openLibraryEdition: record.key };
  if (workKeys.length) identifiers.openLibraryWorks = workKeys.join(',');
  if (authorKeys.length) identifiers.openLibraryAuthors = authorKeys.join(',');
  return identifiers;
}

function error(message, code, lineNumber) {
  return new SnapshotRecordError(message, { code, lineNumber });
}

async function authorNames(authorLookup, keys) {
  if (!keys.length || !authorLookup || typeof authorLookup.getNames !== 'function') return null;
  const names = await authorLookup.getNames(keys);
  if (!(names instanceof Map)) return null;
  const resolved = keys.map(key => names.get(key));
  return resolved.every(Boolean) ? resolved : null;
}

export async function* mapOpenLibraryEditionRecord(record, { snapshotId, authorLookup } = {}) {
  if (record instanceof SnapshotRecordError) {
    yield record;
    return;
  }
  if (!record || record.type !== '/type/edition' || !plainObject(record.data)) {
    yield error('Open Library row is not an edition record', 'wrong_record_type', record?.lineNumber ?? null);
    return;
  }
  const title = text(record.data.title);
  if (!title) {
    yield error(`Edition ${record.key} has no title`, 'missing_title', record.lineNumber);
    return;
  }
  const authorKeys = referenceKeys(record.data.authors);
  let authors;
  try { authors = await authorNames(authorLookup, authorKeys); }
  catch (cause) {
    yield new SnapshotRecordError(`Unable to resolve edition authors for ${record.key}`, { code: 'author_lookup_error', lineNumber: record.lineNumber, cause });
    return;
  }
  if (!authors?.length) {
    yield error(`Edition ${record.key} has no reliable author names`, 'missing_author', record.lineNumber);
    return;
  }
  const isbns = isbn13Values(record.data);
  if (!isbns.values.length) {
    yield error(`Edition ${record.key} has no usable ISBN`, 'no_usable_isbn', record.lineNumber);
    return;
  }
  if (isbns.invalid) yield error(`Edition ${record.key} includes malformed ISBN identifiers`, 'malformed_isbn_identifier', record.lineNumber);
  const workKeys = referenceKeys(record.data.works);
  const base = {
    recordId: record.key,
    snapshotId: text(snapshotId),
    sourceName: OPEN_LIBRARY_BULK_SOURCE,
    title,
    subtitle: text(record.data.subtitle),
    authors,
    language: editionLanguage(record.data.languages),
    publisher: firstText(record.data.publishers),
    publicationDate: text(record.data.publish_date ?? record.data.publication_date),
    publicationYear: publicationYear(record.data),
    format: normalizeFormat(record.data.physical_format),
    cover: cover(record.data.covers),
    description: description(record.data.description),
    subjects: Array.isArray(record.data.subjects) ? [...new Set(record.data.subjects.map(text).filter(Boolean))] : [],
    sourceIdentifiers: sourceIdentifiers(record, workKeys, authorKeys),
  };
  for (const isbn13 of isbns.values) {
    try { yield validateCanonicalCandidate({ ...base, isbn13 }); }
    catch (cause) {
      yield new SnapshotRecordError(`Malformed edition ${record.key}`, { code: cause?.code ?? 'malformed_edition_fields', lineNumber: record.lineNumber, cause });
    }
  }
}

export async function* readOpenLibraryEditionCandidates({ inputPath, snapshotId, authorLookup }) {
  for await (const record of readOpenLibraryBulkRecords(inputPath)) {
    yield* mapOpenLibraryEditionRecord(record, { snapshotId, authorLookup });
  }
}

function authorIndexMetadata({ snapshotId, generatedAt, statistics }) {
  return {
    format: AUTHOR_INDEX_FORMAT,
    indexVersion: OPEN_LIBRARY_AUTHOR_INDEX_VERSION,
    sourceName: OPEN_LIBRARY_BULK_SOURCE,
    snapshotId,
    generatedAt,
    shardCount: AUTHOR_SHARD_COUNT,
    statistics,
  };
}

function validateAuthorIndexMetadata(value) {
  if (!plainObject(value) || Object.keys(value).length !== 7) fail('invalid_author_index', 'Author index metadata is malformed');
  if (value.format !== AUTHOR_INDEX_FORMAT || value.indexVersion !== OPEN_LIBRARY_AUTHOR_INDEX_VERSION || value.sourceName !== OPEN_LIBRARY_BULK_SOURCE || value.shardCount !== AUTHOR_SHARD_COUNT) {
    fail('invalid_author_index', 'Author index metadata has incompatible versions or source');
  }
  if (!text(value.snapshotId) || typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt)) || !plainObject(value.statistics)) {
    fail('invalid_author_index', 'Author index metadata is malformed');
  }
  for (const field of ['input', 'accepted', 'rejected', 'duplicates', 'conflicts']) if (!Number.isSafeInteger(value.statistics[field]) || value.statistics[field] < 0) fail('invalid_author_index', `statistics.${field} is invalid`);
  return value;
}

async function readAuthorIndexMetadata(path) {
  try { return validateAuthorIndexMetadata(JSON.parse(await fs.readFile(join(path, 'index.json'), 'utf8'))); }
  catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    throw new CatalogContractError('invalid_author_index', `Unable to read author index: ${cause.message}`);
  }
}

async function sqlite() {
  try { return await import('node:sqlite'); }
  catch (cause) {
    throw new CatalogContractError('sqlite_unavailable', `Open Library author lookup requires node:sqlite; run this catalog command with --experimental-sqlite (${cause.message})`);
  }
}

function lookupMetadata(database) {
  const row = database.prepare(`
    SELECT snapshot_id, source_name, author_index_version, lookup_format,
           lookup_version, source_author_count, author_count, conflicted_count
      FROM metadata
     WHERE singleton = 1
  `).get();
  if (!row || row.lookup_format !== AUTHOR_LOOKUP_FORMAT || row.lookup_version !== OPEN_LIBRARY_AUTHOR_LOOKUP_VERSION
      || row.source_name !== OPEN_LIBRARY_BULK_SOURCE || row.author_index_version !== OPEN_LIBRARY_AUTHOR_INDEX_VERSION
      || typeof row.snapshot_id !== 'string' || !row.snapshot_id
      || !Number.isSafeInteger(row.source_author_count) || row.source_author_count < 0
      || !Number.isSafeInteger(row.author_count) || row.author_count < 0
      || !Number.isSafeInteger(row.conflicted_count) || row.conflicted_count < 0) {
    fail('invalid_author_lookup', 'Open Library author lookup metadata is malformed or incompatible');
  }
  return row;
}

function validateLookupMetadata(database, authorMetadata) {
  const metadata = lookupMetadata(database);
  if (metadata.snapshot_id !== authorMetadata.snapshotId) fail('author_snapshot_mismatch', 'SQLite author lookup snapshotId does not match the author index');
  if (metadata.source_author_count !== authorMetadata.statistics.accepted) fail('invalid_author_lookup', 'SQLite author lookup source count does not match the author index');
  return metadata;
}

async function validateBuiltAuthorLookup(path, authorMetadata) {
  const { DatabaseSync } = await sqlite();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const metadata = validateLookupMetadata(database, authorMetadata);
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail('invalid_author_lookup', 'SQLite author lookup failed integrity validation');
    const count = database.prepare('SELECT COUNT(*) AS count FROM authors').get().count;
    const conflicts = database.prepare('SELECT COUNT(*) AS count FROM authors WHERE conflicted = 1').get().count;
    if (count !== metadata.author_count || conflicts !== metadata.conflicted_count) fail('invalid_author_lookup', 'SQLite author lookup row counts do not match metadata');
    database.prepare('SELECT name, conflicted FROM authors WHERE key = ?').get('/authors/validation-probe');
    return metadata;
  } finally {
    database.close();
  }
}

export async function buildOpenLibraryAuthorLookup({ indexPath, snapshotId, batchSize = AUTHOR_LOOKUP_BATCH_SIZE }) {
  const path = resolve(indexPath);
  const metadata = await readAuthorIndexMetadata(path);
  if (snapshotId && metadata.snapshotId !== snapshotId) fail('author_snapshot_mismatch', 'Author index snapshotId does not match the requested lookup snapshot');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) fail('invalid_author_lookup', 'batchSize must be a positive safe integer');

  const outputPath = join(path, AUTHOR_LOOKUP_FILE);
  const tempPath = `${outputPath}.building-${process.pid}-${Date.now()}`;
  const { DatabaseSync } = await sqlite();
  let database;
  let sourceAuthorCount = 0;
  let authorCount = 0;
  let conflictedCount = 0;
  let pending = 0;
  let transactionOpen = false;
  try {
    await fs.rm(tempPath, { force: true });
    database = new DatabaseSync(tempPath);
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -32768;
      PRAGMA locking_mode = EXCLUSIVE;
      CREATE TABLE metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        snapshot_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        author_index_version INTEGER NOT NULL,
        lookup_format TEXT NOT NULL,
        lookup_version INTEGER NOT NULL,
        source_author_count INTEGER NOT NULL,
        author_count INTEGER NOT NULL,
        conflicted_count INTEGER NOT NULL
      );
      CREATE TABLE authors (
        key TEXT PRIMARY KEY,
        name TEXT,
        conflicted INTEGER NOT NULL CHECK (conflicted IN (0, 1)),
        CHECK ((conflicted = 0 AND name IS NOT NULL) OR (conflicted = 1 AND name IS NULL))
      ) WITHOUT ROWID;
      PRAGMA user_version = ${OPEN_LIBRARY_AUTHOR_LOOKUP_VERSION};
      BEGIN IMMEDIATE;
    `);
    transactionOpen = true;
    const insertAuthor = database.prepare('INSERT INTO authors (key, name, conflicted) VALUES (?, ?, ?)');
    const insertMetadata = database.prepare(`
      INSERT INTO metadata (
        singleton, snapshot_id, source_name, author_index_version, lookup_format,
        lookup_version, source_author_count, author_count, conflicted_count
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    function writeAuthor(key, name, conflicted) {
      insertAuthor.run(key, conflicted ? null : name, conflicted ? 1 : 0);
      authorCount += 1;
      if (conflicted) conflictedCount += 1;
      pending += 1;
      if (pending >= batchSize) {
        database.exec('COMMIT; BEGIN IMMEDIATE;');
        pending = 0;
      }
    }

    for (let shard = 0; shard < AUTHOR_SHARD_COUNT; shard++) {
      let currentKey = null;
      let currentName = null;
      let conflicted = false;
      let previousKey = null;
      let previousName = null;
      try {
        for await (const row of readNdjson(join(path, 'authors', shardName(shard)))) {
          const key = typeof row?.key === 'string' ? row.key : null;
          const name = text(row?.name);
          if (!plainObject(row) || !key || !name) fail('invalid_author_index', `Malformed author row in shard ${shardName(shard)}`);
          if (previousKey !== null && (previousKey.localeCompare(key) > 0 || (previousKey === key && previousName.localeCompare(name) > 0))) {
            fail('invalid_author_index', `Author shard ${shardName(shard)} is not sorted`);
          }
          previousKey = key;
          previousName = name;
          sourceAuthorCount += 1;
          if (key !== currentKey) {
            if (currentKey !== null) writeAuthor(currentKey, currentName, conflicted);
            currentKey = key;
            currentName = name;
            conflicted = false;
          } else if (name !== currentName) {
            conflicted = true;
          }
        }
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
      }
      if (currentKey !== null) writeAuthor(currentKey, currentName, conflicted);
    }
    if (sourceAuthorCount !== metadata.statistics.accepted) fail('invalid_author_index', 'Author shard row count does not match index metadata');
    database.exec('COMMIT;');
    transactionOpen = false;
    database.exec('PRAGMA locking_mode = NORMAL; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
    transactionOpen = true;
    insertMetadata.run(
      metadata.snapshotId, OPEN_LIBRARY_BULK_SOURCE, OPEN_LIBRARY_AUTHOR_INDEX_VERSION,
      AUTHOR_LOOKUP_FORMAT, OPEN_LIBRARY_AUTHOR_LOOKUP_VERSION, sourceAuthorCount, authorCount, conflictedCount,
    );
    database.exec('COMMIT;');
    transactionOpen = false;
    database.exec('PRAGMA optimize;');
    database.close();
    database = null;

    await validateBuiltAuthorLookup(tempPath, metadata);
    await fs.rename(tempPath, outputPath);
    return {
      format: AUTHOR_LOOKUP_FORMAT,
      lookupVersion: OPEN_LIBRARY_AUTHOR_LOOKUP_VERSION,
      snapshotId: metadata.snapshotId,
      sourceName: OPEN_LIBRARY_BULK_SOURCE,
      sourceAuthorCount,
      authorCount,
      conflictedCount,
      outputPath,
    };
  } catch (cause) {
    if (database && transactionOpen) {
      try { database.exec('ROLLBACK;'); } catch {}
    }
    throw cause;
  } finally {
    if (database) {
      try { database.close(); } catch {}
    }
    await fs.rm(tempPath, { force: true }).catch(() => {});
    await fs.rm(`${tempPath}-journal`, { force: true }).catch(() => {});
    await fs.rm(`${tempPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${tempPath}-shm`, { force: true }).catch(() => {});
  }
}


async function appendAuthor(handles, directory, key, value) {
  const path = join(directory, shardName(shardFor(key)));
  let handle = handles.get(path);
  if (!handle) {
    await fs.mkdir(dirname(path), { recursive: true });
    handle = { file: await fs.open(path, 'a'), buffer: '' };
    handles.set(path, handle);
  }
  handle.buffer += `${stableJson(value)}\n`;
  if (handle.buffer.length >= DEFAULT_WRITE_BUFFER_BYTES) {
    await handle.file.writeFile(handle.buffer, 'utf8');
    handle.buffer = '';
  }
}

async function closeHandles(handles) {
  await Promise.all([...handles.values()].map(async handle => {
    if (handle.buffer) await handle.file.writeFile(handle.buffer, 'utf8');
    await handle.file.close();
  }));
}

function authorOrder(left, right) {
  return left.key.localeCompare(right.key) || left.name.localeCompare(right.name);
}

async function reduceAuthorShard({ sortedPath, outputPath, statistics }) {
  const output = await fs.open(outputPath, 'w');
  let buffer = '';
  let key = null;
  let lastName = null;
  let distinctNames = 0;
  try {
    for await (const row of readNdjson(sortedPath)) {
      if (!plainObject(row) || typeof row.key !== 'string' || !text(row.name)) fail('invalid_author_index', 'Malformed sorted author row');
      if (key !== row.key) {
        key = row.key;
        lastName = null;
        distinctNames = 0;
      }
      if (row.name === lastName) {
        statistics.duplicates += 1;
        continue;
      }
      if (distinctNames > 0) statistics.conflicts += 1;
      distinctNames += 1;
      lastName = row.name;
      statistics.accepted += 1;
      buffer += `${stableJson({ key: row.key, name: text(row.name) })}\n`;
      if (buffer.length >= DEFAULT_WRITE_BUFFER_BYTES) {
        await output.writeFile(buffer, 'utf8');
        buffer = '';
      }
    }
    if (buffer) await output.writeFile(buffer, 'utf8');
  } finally {
    await output.close();
  }
}

async function validateBuiltAuthorIndex(path, metadata) {
  validateAuthorIndexMetadata(metadata);
  let count = 0;
  for (let shard = 0; shard < AUTHOR_SHARD_COUNT; shard++) {
    try {
      for await (const row of readNdjson(join(path, 'authors', shardName(shard)))) {
        if (!plainObject(row) || typeof row.key !== 'string' || !text(row.name)) fail('invalid_author_index', 'Malformed final author row');
        count += 1;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (count !== metadata.statistics.accepted) fail('invalid_author_index', 'Final author count does not match metadata');
}

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

export async function buildOpenLibraryAuthorIndex({
  inputPath,
  outputPath,
  snapshotId,
  generatedAt = new Date().toISOString(),
  sortChunkSize = DEFAULT_SORT_CHUNK_SIZE,
  maxOpenRuns = DEFAULT_MAX_OPEN_RUNS,
  onSortRun = null,
}) {
  snapshotId = text(snapshotId);
  if (!snapshotId) fail('invalid_author_index', 'snapshotId is required');
  outputPath = resolve(outputPath);
  const tempPath = `${outputPath}.building-${process.pid}-${Date.now()}`;
  const handles = new Map();
  const statistics = { input: 0, accepted: 0, rejected: 0, duplicates: 0, conflicts: 0 };
  try {
    await fs.rm(tempPath, { recursive: true, force: true });
    await fs.mkdir(join(tempPath, 'authors'), { recursive: true });
    for await (const record of readOpenLibraryBulkRecords(inputPath)) {
      statistics.input += 1;
      if (record instanceof SnapshotRecordError || record.type !== '/type/author' || !plainObject(record.data)) {
        statistics.rejected += 1;
        continue;
      }
      const key = text(record.key);
      const name = text(record.data.name);
      if (!key || !name) {
        statistics.rejected += 1;
        continue;
      }
      await appendAuthor(handles, join(tempPath, 'authors-source'), key, { key, name });
    }
    await closeHandles(handles);
    for (let shard = 0; shard < AUTHOR_SHARD_COUNT; shard++) {
      const name = shardName(shard);
      const sortedPath = join(tempPath, 'authors-sorted', name);
      await externalSortNdjson({
        inputPath: join(tempPath, 'authors-source', name),
        outputPath: sortedPath,
        compare: authorOrder,
        runDirectory: join(tempPath, 'runs', `authors-${shard}`),
        chunkSize: sortChunkSize,
        maxOpenRuns,
        onRun: onSortRun,
      });
      try {
        await fs.mkdir(join(tempPath, 'authors'), { recursive: true });
        await reduceAuthorShard({ sortedPath, outputPath: join(tempPath, 'authors', name), statistics });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rm(join(tempPath, 'runs'), { recursive: true, force: true });
    await Promise.all(['authors-source', 'authors-sorted'].map(directory => fs.rm(join(tempPath, directory), { recursive: true, force: true })));
    const metadata = authorIndexMetadata({ snapshotId, generatedAt, statistics });
    await fs.writeFile(join(tempPath, 'index.json'), `${stableJson(metadata)}\n`, 'utf8');
    await validateBuiltAuthorIndex(tempPath, metadata);
    await replaceDirectory(tempPath, outputPath);
    return validateAuthorIndexMetadata(metadata);
  } catch (cause) {
    await closeHandles(handles).catch(() => {});
    await fs.rm(tempPath, { recursive: true, force: true });
    throw cause;
  }
}

export async function createOpenLibraryAuthorLookup({ indexPath, snapshotId }) {
  const path = resolve(indexPath);
  const metadata = await readAuthorIndexMetadata(path);
  if (snapshotId && metadata.snapshotId !== snapshotId) fail('author_snapshot_mismatch', 'Author index snapshotId does not match the edition snapshot');
  const lookupPath = join(path, AUTHOR_LOOKUP_FILE);
  try {
    await fs.access(lookupPath);
    const { DatabaseSync } = await sqlite();
    const database = new DatabaseSync(lookupPath, { readOnly: true });
    try {
      validateLookupMetadata(database, metadata);
      const query = database.prepare('SELECT name, conflicted FROM authors WHERE key = ?');
      let closed = false;
      return {
        async getNames(keys) {
          const result = new Map();
          for (const key of new Set(keys)) {
            const row = query.get(key);
            if (row && row.conflicted === 0 && typeof row.name === 'string') result.set(key, row.name);
          }
          return result;
        },
        close() {
          if (!closed) {
            database.close();
            closed = true;
          }
        },
      };
    } catch (cause) {
      database.close();
      throw cause;
    }
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  const conflict = Symbol('conflicting_author_names');
  const shardCache = new Map();

  async function loadShard(shard) {
    const names = new Map();
    try {
      for await (const row of readNdjson(join(path, 'authors', shardName(shard)))) {
        const key = typeof row?.key === 'string' ? row.key : null;
        const name = text(row?.name);
        if (key === null || !name) continue;
        const existing = names.get(key);
        if (existing === undefined) names.set(key, name);
        else if (existing !== name) names.set(key, conflict);
      }
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
    return names;
  }

  function getShard(shard) {
    let names = shardCache.get(shard);
    if (!names) {
      names = loadShard(shard);
      shardCache.set(shard, names);
    }
    return names;
  }

  return {
    async getNames(keys) {
      const requestedKeys = [...keys];
      const shardNames = new Map();
      const result = new Map();
      for (const key of requestedKeys) {
        const shard = shardFor(key);
        if (!shardNames.has(shard)) shardNames.set(shard, await getShard(shard));
      }
      for (const key of requestedKeys) {
        const name = shardNames.get(shardFor(key)).get(key);
        if (typeof name === 'string') result.set(key, name);
      }
      return result;
    },
  };
}
