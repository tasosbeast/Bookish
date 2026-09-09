import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CANONICAL_SOURCE_CONTRACT_VERSION,
  CatalogContractError,
  validateSourceEntry,
} from './contracts.js';
import { validateCanonicalCandidate } from './canonical-source.js';
import { normalizeAuthorName, normalizeTitle } from './normalize.js';
import { SnapshotRecordError } from './snapshot-reader.js';

export const SNAPSHOT_INDEX_VERSION = 1;
export const SNAPSHOT_INDEX_SHARD_COUNT = 64;
const INDEX_FORMAT = 'bookish-canonical-snapshot-index';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_snapshot_index', `${name} must be a non-empty string`);
  return value.trim().replace(/\s+/g, ' ');
}

function exactKeys(value, allowed, name) {
  if (!plainObject(value)) fail('invalid_snapshot_index', `${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('invalid_snapshot_index', `${name} contains unexpected field ${key}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function titleAuthorKey(candidate) {
  return `${normalizeTitle(candidate.title)}\u0000${normalizeAuthorName(candidate.authors[0])}`;
}

function shardFor(value, shardCount = SNAPSHOT_INDEX_SHARD_COUNT) {
  return Number.parseInt(hash(value).slice(0, 8), 16) % shardCount;
}

function shardName(shard) {
  return `${String(shard).padStart(2, '0')}.ndjson`;
}

function recordKey(candidate) {
  return `sha256:${hash(stableJson(candidate))}`;
}

function candidateOrder(left, right) {
  return left.candidate.isbn13.localeCompare(right.candidate.isbn13)
    || left.candidate.title.localeCompare(right.candidate.title)
    || left.candidate.authors.join('\u0000').localeCompare(right.candidate.authors.join('\u0000'))
    || left.recordKey.localeCompare(right.recordKey);
}

function pointerOrder(left, right) {
  return left.key.localeCompare(right.key) || left.recordKey.localeCompare(right.recordKey);
}

function emptyStats() {
  return {
    input: 0,
    accepted: 0,
    rejected: 0,
    duplicateIsbnGroups: 0,
    conflictingDuplicateIsbnGroups: 0,
    duplicateRecords: 0,
    rejectionCodes: {},
  };
}

function addRejection(stats, code) {
  stats.rejected += 1;
  stats.rejectionCodes[code] = (stats.rejectionCodes[code] ?? 0) + 1;
}

function metadataFor({ sourceName, snapshotId, generatedAt, stats }) {
  return {
    format: INDEX_FORMAT,
    indexVersion: SNAPSHOT_INDEX_VERSION,
    canonicalContractVersion: CANONICAL_SOURCE_CONTRACT_VERSION,
    sourceName,
    snapshotId,
    generatedAt,
    recordCount: stats.accepted,
    shardCount: SNAPSHOT_INDEX_SHARD_COUNT,
    statistics: stats,
  };
}

function validateStatistics(value) {
  exactKeys(value, ['input', 'accepted', 'rejected', 'duplicateIsbnGroups', 'conflictingDuplicateIsbnGroups', 'duplicateRecords', 'rejectionCodes'], 'Index statistics');
  for (const field of ['input', 'accepted', 'rejected', 'duplicateIsbnGroups', 'conflictingDuplicateIsbnGroups', 'duplicateRecords']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) fail('invalid_snapshot_index', `statistics.${field} must be a non-negative integer`);
  }
  if (!plainObject(value.rejectionCodes) || Object.values(value.rejectionCodes).some(count => !Number.isSafeInteger(count) || count < 1)) {
    fail('invalid_snapshot_index', 'statistics.rejectionCodes must contain positive integer counts');
  }
  return { ...value, rejectionCodes: { ...value.rejectionCodes } };
}

export function validateSnapshotIndexMetadata(value) {
  exactKeys(value, ['format', 'indexVersion', 'canonicalContractVersion', 'sourceName', 'snapshotId', 'generatedAt', 'recordCount', 'shardCount', 'statistics'], 'Snapshot index metadata');
  if (value.format !== INDEX_FORMAT) fail('invalid_snapshot_index', `format must equal ${INDEX_FORMAT}`);
  if (value.indexVersion !== SNAPSHOT_INDEX_VERSION) fail('invalid_snapshot_index_version', `indexVersion must equal ${SNAPSHOT_INDEX_VERSION}`);
  if (value.canonicalContractVersion !== CANONICAL_SOURCE_CONTRACT_VERSION) fail('invalid_canonical_contract_version', `canonicalContractVersion must equal ${CANONICAL_SOURCE_CONTRACT_VERSION}`);
  const sourceName = text(value.sourceName, 'sourceName');
  const snapshotId = text(value.snapshotId, 'snapshotId');
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) fail('invalid_snapshot_index', 'generatedAt must be an ISO date string');
  if (!Number.isSafeInteger(value.recordCount) || value.recordCount < 0) fail('invalid_snapshot_index', 'recordCount must be a non-negative integer');
  if (value.shardCount !== SNAPSHOT_INDEX_SHARD_COUNT) fail('invalid_snapshot_index', `shardCount must equal ${SNAPSHOT_INDEX_SHARD_COUNT}`);
  return {
    format: value.format,
    indexVersion: value.indexVersion,
    canonicalContractVersion: value.canonicalContractVersion,
    sourceName,
    snapshotId,
    generatedAt: value.generatedAt,
    recordCount: value.recordCount,
    shardCount: value.shardCount,
    statistics: validateStatistics(value.statistics),
  };
}

async function append(handles, directory, shard, value) {
  const path = join(directory, shardName(shard));
  let handle = handles.get(path);
  if (!handle) {
    await fs.mkdir(dirname(path), { recursive: true });
    handle = await fs.open(path, 'a');
    handles.set(path, handle);
  }
  await handle.writeFile(`${stableJson(value)}\n`, 'utf8');
}

async function closeAll(handles) {
  await Promise.all([...handles.values()].map(handle => handle.close()));
}

async function sortShardDirectory(directory, comparator) {
  let files;
  try { files = await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const file of files.sort()) {
    const path = join(directory, file);
    const rows = (await fs.readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).sort(comparator);
    await fs.writeFile(path, `${rows.map(stableJson).join('\n')}\n`, 'utf8');
  }
}

async function replaceDirectory(tempPath, outputPath) {
  const backupPath = `${outputPath}.previous-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    await fs.rename(outputPath, backupPath);
    movedExisting = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(tempPath, outputPath);
  } catch (error) {
    if (movedExisting) await fs.rename(backupPath, outputPath).catch(() => {});
    throw error;
  }
  if (movedExisting) await fs.rm(backupPath, { recursive: true, force: true });
}

export async function buildSnapshotIndex({ records, outputPath, sourceName, snapshotId, generatedAt = new Date().toISOString() }) {
  if (!records || typeof records[Symbol.asyncIterator] !== 'function') fail('invalid_snapshot_reader', 'records must be an async iterable');
  sourceName = text(sourceName, 'sourceName');
  snapshotId = text(snapshotId, 'snapshotId');
  outputPath = resolve(outputPath);
  const tempPath = `${outputPath}.building-${process.pid}-${Date.now()}`;
  const stats = emptyStats();
  const handles = new Map();
  const seenRecordKeys = new Set();
  const isbnGroups = new Map();
  try {
    await fs.rm(tempPath, { recursive: true, force: true });
    await fs.mkdir(join(tempPath, 'records'), { recursive: true });
    await fs.mkdir(join(tempPath, 'lookup-isbn'), { recursive: true });
    await fs.mkdir(join(tempPath, 'lookup-title-author'), { recursive: true });
    for await (const rawRecord of records) {
      stats.input += 1;
      if (rawRecord instanceof SnapshotRecordError) {
        addRejection(stats, rawRecord.code);
        continue;
      }
      let candidate;
      try {
        candidate = validateCanonicalCandidate(rawRecord);
        if (candidate.sourceName !== sourceName || candidate.snapshotId !== snapshotId) {
          fail('snapshot_identity_mismatch', 'Canonical record sourceName and snapshotId must match index metadata');
        }
      } catch (error) {
        addRejection(stats, error instanceof CatalogContractError ? error.code : 'invalid_snapshot_record');
        continue;
      }
      const key = recordKey(candidate);
      const group = isbnGroups.get(candidate.isbn13) ?? { total: 0, recordKeys: new Set() };
      group.total += 1;
      group.recordKeys.add(key);
      isbnGroups.set(candidate.isbn13, group);
      if (seenRecordKeys.has(key)) {
        stats.duplicateRecords += 1;
        continue;
      }
      seenRecordKeys.add(key);
      stats.accepted += 1;
      const titleKey = titleAuthorKey(candidate);
      const recordShard = shardFor(titleKey);
      const record = { recordKey: key, candidate };
      await append(handles, join(tempPath, 'records'), recordShard, record);
      await append(handles, join(tempPath, 'lookup-isbn'), shardFor(candidate.isbn13), { key: candidate.isbn13, recordKey: key, recordShard });
      await append(handles, join(tempPath, 'lookup-title-author'), recordShard, { key: titleKey, recordKey: key, recordShard });
    }
    await closeAll(handles);
    for (const group of isbnGroups.values()) {
      if (group.total > 1) stats.duplicateIsbnGroups += 1;
      if (group.recordKeys.size > 1) stats.conflictingDuplicateIsbnGroups += 1;
    }
    await sortShardDirectory(join(tempPath, 'records'), candidateOrder);
    await sortShardDirectory(join(tempPath, 'lookup-isbn'), pointerOrder);
    await sortShardDirectory(join(tempPath, 'lookup-title-author'), pointerOrder);
    const metadata = metadataFor({ sourceName, snapshotId, generatedAt, stats });
    await fs.writeFile(join(tempPath, 'index.json'), `${stableJson(metadata)}\n`, 'utf8');
    await replaceDirectory(tempPath, outputPath);
    return validateSnapshotIndexMetadata(metadata);
  } catch (error) {
    await closeAll(handles).catch(() => {});
    await fs.rm(tempPath, { recursive: true, force: true });
    throw error;
  }
}

async function readJsonLines(path) {
  try {
    const content = await fs.readFile(path, 'utf8');
    if (!content.trim()) return [];
    return content.trim().split('\n').map((line, index) => {
      try { return JSON.parse(line); }
      catch { fail('corrupt_snapshot_index', `Invalid JSON in ${path} line ${index + 1}`); }
    });
  } catch (error) {
    if (error instanceof CatalogContractError) throw error;
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readRecord(path, expectedRecordKey, metadata) {
  const records = await readJsonLines(path);
  const record = records.find(item => item?.recordKey === expectedRecordKey);
  if (!record || !plainObject(record) || Object.keys(record).length !== 2 || !own(record, 'recordKey') || !own(record, 'candidate')) {
    fail('corrupt_snapshot_index', `Missing or malformed record ${expectedRecordKey}`);
  }
  const candidate = validateCanonicalCandidate(record.candidate);
  if (candidate.sourceName !== metadata.sourceName || candidate.snapshotId !== metadata.snapshotId) {
    fail('snapshot_identity_mismatch', 'Index record does not match index sourceName or snapshotId');
  }
  if (record.recordKey !== recordKey(candidate)) fail('corrupt_snapshot_index', `Record key does not match record ${expectedRecordKey}`);
  return { recordKey: record.recordKey, candidate };
}

async function readPointers(directory, key, metadata) {
  const rows = await readJsonLines(join(directory, shardName(shardFor(key, metadata.shardCount))));
  return rows.filter(row => {
    if (!plainObject(row) || Object.keys(row).length !== 3 || typeof row.key !== 'string' || typeof row.recordKey !== 'string' || !Number.isInteger(row.recordShard)) {
      fail('corrupt_snapshot_index', 'Malformed lookup pointer');
    }
    return row.key === key;
  });
}

export async function readSnapshotIndexMetadata(indexPath) {
  try {
    return validateSnapshotIndexMetadata(JSON.parse(await fs.readFile(join(resolve(indexPath), 'index.json'), 'utf8')));
  } catch (error) {
    if (error instanceof CatalogContractError) throw error;
    throw new CatalogContractError('invalid_snapshot_index', `Unable to read snapshot index metadata: ${error.message}`);
  }
}

export async function createLocalCanonicalAdapter({ indexPath }) {
  const path = resolve(indexPath);
  const metadata = await readSnapshotIndexMetadata(path);
  return {
    sourceName: metadata.sourceName,
    async getCandidates(sourceValue) {
      const source = validateSourceEntry(sourceValue);
      const exactIsbn = source.pinnedIsbn13 ?? source.preferredIsbn13 ?? null;
      const titleKey = `${normalizeTitle(source.title)}\u0000${normalizeAuthorName(source.author)}`;
      const exactPointers = exactIsbn ? await readPointers(join(path, 'lookup-isbn'), exactIsbn, metadata) : [];
      const titlePointers = await readPointers(join(path, 'lookup-title-author'), titleKey, metadata);
      const seen = new Set();
      const pointers = [...exactPointers, ...titlePointers].filter(pointer => {
        if (seen.has(pointer.recordKey)) return false;
        seen.add(pointer.recordKey);
        return true;
      });
      const candidates = await Promise.all(pointers.map(async pointer => readRecord(join(path, 'records', shardName(pointer.recordShard)), pointer.recordKey, metadata)));
      const exactKeys = new Set(exactPointers.map(pointer => pointer.recordKey));
      return candidates.sort((left, right) => {
        const exactOrder = Number(exactKeys.has(right.recordKey)) - Number(exactKeys.has(left.recordKey));
        return exactOrder || candidateOrder(left, right);
      }).map(record => record.candidate);
    },
  };
}
