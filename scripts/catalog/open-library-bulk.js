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

export const OPEN_LIBRARY_BULK_SOURCE = 'open-library-bulk';
export const OPEN_LIBRARY_AUTHOR_INDEX_VERSION = 1;
const AUTHOR_INDEX_FORMAT = 'bookish-open-library-author-index';
const AUTHOR_SHARD_COUNT = 64;

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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
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
  for (const field of ['input', 'accepted', 'rejected', 'conflicts']) if (!Number.isSafeInteger(value.statistics[field]) || value.statistics[field] < 0) fail('invalid_author_index', `statistics.${field} is invalid`);
  return value;
}

async function appendAuthor(handles, directory, key, value) {
  const path = join(directory, shardName(shardFor(key)));
  let handle = handles.get(path);
  if (!handle) {
    await fs.mkdir(dirname(path), { recursive: true });
    handle = await fs.open(path, 'a');
    handles.set(path, handle);
  }
  await handle.writeFile(`${stableJson(value)}\n`, 'utf8');
}

async function closeHandles(handles) {
  await Promise.all([...handles.values()].map(handle => handle.close()));
}

async function sortAuthorShards(path) {
  const files = await fs.readdir(path);
  for (const file of files.sort()) {
    const shard = join(path, file);
    const rows = (await fs.readFile(shard, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
      .sort((left, right) => left.key.localeCompare(right.key) || left.name.localeCompare(right.name));
    await fs.writeFile(shard, `${rows.map(stableJson).join('\n')}\n`, 'utf8');
  }
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

export async function buildOpenLibraryAuthorIndex({ inputPath, outputPath, snapshotId, generatedAt = new Date().toISOString() }) {
  snapshotId = text(snapshotId);
  if (!snapshotId) fail('invalid_author_index', 'snapshotId is required');
  outputPath = resolve(outputPath);
  const tempPath = `${outputPath}.building-${process.pid}-${Date.now()}`;
  const handles = new Map();
  const seen = new Map();
  const statistics = { input: 0, accepted: 0, rejected: 0, conflicts: 0 };
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
      const names = seen.get(key) ?? new Set();
      if (names.has(name)) continue;
      if (names.size) statistics.conflicts += 1;
      names.add(name);
      seen.set(key, names);
      statistics.accepted += 1;
      await appendAuthor(handles, join(tempPath, 'authors'), key, { key, name });
    }
    await closeHandles(handles);
    await sortAuthorShards(join(tempPath, 'authors'));
    const metadata = authorIndexMetadata({ snapshotId, generatedAt, statistics });
    await fs.writeFile(join(tempPath, 'index.json'), `${stableJson(metadata)}\n`, 'utf8');
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
  let metadata;
  try { metadata = validateAuthorIndexMetadata(JSON.parse(await fs.readFile(join(path, 'index.json'), 'utf8'))); }
  catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    throw new CatalogContractError('invalid_author_index', `Unable to read author index: ${cause.message}`);
  }
  if (snapshotId && metadata.snapshotId !== snapshotId) fail('author_snapshot_mismatch', 'Author index snapshotId does not match the edition snapshot');
  return {
    async getNames(keys) {
      const result = new Map();
      for (const key of keys) {
        const file = join(path, 'authors', shardName(shardFor(key)));
        let rows = [];
        try { rows = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
        catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        const names = [...new Set(rows.filter(row => row?.key === key && text(row.name)).map(row => text(row.name)))];
        if (names.length === 1) result.set(key, names[0]);
      }
      return result;
    },
  };
}
