import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  CatalogContractError,
  manifestFingerprint,
  validateSourceEntry,
  validateSourceManifest,
} from './contracts.js';
import { validateCanonicalCandidate } from './canonical-source.js';
import { normalizeAuthorName, normalizeTitle } from './normalize.js';
import { SnapshotRecordError } from './snapshot-reader.js';
import { stableJson } from './external-sort.js';
import {
  OPEN_LIBRARY_BULK_SOURCE,
  authorNames,
  createOpenLibraryAuthorLookup,
  isbn13Values,
  mapOpenLibraryEditionRecord,
  readOpenLibraryBulkRecords,
} from './open-library-bulk.js';

export const TARGETED_ARTIFACT_FORMAT = 'bookish-open-library-targeted-candidates';
export const TARGETED_ARTIFACT_VERSION = 1;
export const DEFAULT_TARGETED_BATCH_SIZE = 10_000;

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
}

export function recordKey(candidate) {
  return `sha256:${createHash('sha256').update(stableJson(candidate)).digest('hex')}`;
}

async function sqlite() {
  try {
    return await import('node:sqlite');
  } catch (cause) {
    throw new CatalogContractError('sqlite_unavailable', `Targeted extraction requires node:sqlite; run this command with --experimental-sqlite (${cause.message})`);
  }
}

async function replaceArtifactFile(tempPath, targetPath) {
  const backup = `${targetPath}.previous-${process.pid}-${Date.now()}`;
  let moved = false;
  try {
    await fs.rename(targetPath, backup);
    moved = true;
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  try {
    await fs.rename(tempPath, targetPath);
  } catch (cause) {
    if (moved) {
      await fs.rename(backup, targetPath).catch(() => {});
    }
    throw cause;
  }
  if (moved) {
    await fs.rm(backup, { force: true }).catch(() => {});
  }
}

function validateTargetedArtifactMetadataRow(row) {
  if (!row || typeof row !== 'object') {
    fail('invalid_targeted_artifact', 'Targeted artifact metadata is missing');
  }
  if (row.artifact_format !== TARGETED_ARTIFACT_FORMAT || row.artifact_version !== TARGETED_ARTIFACT_VERSION) {
    fail('invalid_targeted_artifact', 'Targeted artifact format or version is incompatible');
  }
  if (row.source_name !== OPEN_LIBRARY_BULK_SOURCE) {
    fail('invalid_targeted_artifact', 'Targeted artifact source_name is incompatible');
  }
  if (typeof row.snapshot_id !== 'string' || !row.snapshot_id.trim()) {
    fail('invalid_targeted_artifact', 'Targeted artifact snapshot_id is invalid');
  }
  if (typeof row.source_manifest_fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(row.source_manifest_fingerprint)) {
    fail('invalid_targeted_artifact', 'Targeted artifact source_manifest_fingerprint is invalid');
  }
  for (const field of ['source_manifest_count', 'rows_scanned', 'matched_edition_count', 'candidate_association_count']) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
      fail('invalid_targeted_artifact', `Targeted artifact metadata.${field} is invalid`);
    }
  }
  if (typeof row.generated_at !== 'string' || Number.isNaN(Date.parse(row.generated_at))) {
    fail('invalid_targeted_artifact', 'Targeted artifact generated_at is invalid');
  }
  return {
    artifactFormat: row.artifact_format,
    artifactVersion: row.artifact_version,
    sourceName: row.source_name,
    snapshotId: row.snapshot_id,
    sourceManifestFingerprint: row.source_manifest_fingerprint,
    sourceManifestCount: row.source_manifest_count,
    rowsScanned: row.rows_scanned,
    matchedEditionCount: row.matched_edition_count,
    candidateAssociationCount: row.candidate_association_count,
    generatedAt: row.generated_at,
  };
}

export async function readTargetedArtifactMetadata(artifactPath) {
  const { DatabaseSync } = await sqlite();
  let database;
  try {
    database = new DatabaseSync(resolve(artifactPath), { readOnly: true });
    const row = database.prepare(`
      SELECT artifact_format, artifact_version, source_name, snapshot_id,
             source_manifest_fingerprint, source_manifest_count, rows_scanned,
             matched_edition_count, candidate_association_count, generated_at
        FROM metadata
       WHERE singleton = 1
    `).get();
    return validateTargetedArtifactMetadataRow(row);
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    throw new CatalogContractError('invalid_targeted_artifact', `Unable to read targeted artifact metadata: ${cause.message}`);
  } finally {
    if (database) database.close();
  }
}

export async function validateBuiltTargetedArtifact(artifactPath, expectations = {}) {
  const { DatabaseSync } = await sqlite();
  let database;
  try {
    database = new DatabaseSync(resolve(artifactPath), { readOnly: true });
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      fail('corrupt_targeted_artifact', 'Targeted artifact failed SQLite integrity check');
    }
    const row = database.prepare(`
      SELECT artifact_format, artifact_version, source_name, snapshot_id,
             source_manifest_fingerprint, source_manifest_count, rows_scanned,
             matched_edition_count, candidate_association_count, generated_at
        FROM metadata
       WHERE singleton = 1
    `).get();
    const metadata = validateTargetedArtifactMetadataRow(row);

    if (expectations.expectedSnapshotId && metadata.snapshotId !== expectations.expectedSnapshotId) {
      fail('snapshot_identity_mismatch', 'Targeted artifact snapshotId does not match expected snapshot');
    }
    if (expectations.expectedManifestFingerprint && metadata.sourceManifestFingerprint !== expectations.expectedManifestFingerprint) {
      fail('source_manifest_mismatch', 'Targeted artifact source manifest fingerprint does not match expected fingerprint');
    }
    if (expectations.expectedCount !== undefined && metadata.sourceManifestCount !== expectations.expectedCount) {
      fail('source_manifest_mismatch', 'Targeted artifact source count does not match expected count');
    }
    if (expectations.expectedAssociations !== undefined && metadata.candidateAssociationCount !== expectations.expectedAssociations) {
      fail('corrupt_targeted_artifact', 'Targeted artifact association count does not match expected count');
    }

    const actualCount = database.prepare('SELECT COUNT(*) AS total FROM candidates').get().total;
    if (actualCount !== metadata.candidateAssociationCount) {
      fail('corrupt_targeted_artifact', 'Targeted artifact candidate row count does not match metadata association count');
    }

    const candidateRows = database.prepare('SELECT source_key, candidate_record_key, canonical_json FROM candidates').all();
    for (const r of candidateRows) {
      let parsed;
      try {
        parsed = JSON.parse(r.canonical_json);
      } catch {
        fail('corrupt_targeted_artifact', `Malformed JSON in candidate row for source ${r.source_key}`);
      }
      const candidate = validateCanonicalCandidate(parsed);
      if (candidate.sourceName !== metadata.sourceName || candidate.snapshotId !== metadata.snapshotId) {
        fail('snapshot_identity_mismatch', 'Candidate sourceName or snapshotId does not match artifact metadata');
      }
      if (recordKey(candidate) !== r.candidate_record_key) {
        fail('corrupt_targeted_artifact', `Candidate record key mismatch for candidate in source ${r.source_key}`);
      }
    }
    return metadata;
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    throw new CatalogContractError('corrupt_targeted_artifact', `Targeted artifact validation failed: ${cause.message}`);
  } finally {
    if (database) database.close();
  }
}

export async function buildTargetedOpenLibraryArtifact({
  sources,
  inputPath,
  authorIndexPath = null,
  authorLookup = null,
  outputPath,
  snapshotId,
  batchSize = DEFAULT_TARGETED_BATCH_SIZE,
  onProgress = null,
}) {
  const cleanSnapshotId = text(snapshotId);
  if (!cleanSnapshotId) fail('invalid_argument', 'snapshotId is required');
  if (!inputPath) fail('invalid_argument', 'inputPath is required');
  if (!outputPath) fail('invalid_argument', 'outputPath is required');
  if (!authorLookup && !authorIndexPath) fail('invalid_argument', 'authorIndexPath or authorLookup is required');

  let rawSources = sources;
  if (typeof rawSources === 'string') {
    rawSources = JSON.parse(await readFile(resolve(rawSources), 'utf8'));
  }
  const sourceEntries = validateSourceManifest(rawSources);
  const manifestFp = manifestFingerprint(sourceEntries);

  const titleTargets = new Map();
  const isbnTargets = new Map();

  for (const source of sourceEntries) {
    const normTitle = normalizeTitle(source.title);
    if (!titleTargets.has(normTitle)) {
      titleTargets.set(normTitle, []);
    }
    titleTargets.get(normTitle).push(source);

    const exactIsbn = source.pinnedIsbn13 ?? source.preferredIsbn13 ?? null;
    if (exactIsbn) {
      if (!isbnTargets.has(exactIsbn)) {
        isbnTargets.set(exactIsbn, []);
      }
      isbnTargets.get(exactIsbn).push(source);
    }
  }

  const finalPath = resolve(outputPath);
  await fs.mkdir(dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.building-${process.pid}-${Date.now()}`;

  const { DatabaseSync } = await sqlite();
  let database = null;
  let openedLookup = null;
  let activeLookup = authorLookup;
  let transactionOpen = false;

  const statistics = {
    requestedWorks: sourceEntries.length,
    rowsScanned: 0,
    malformedRows: 0,
    rejectedRows: 0,
    rowsPassingTitlePrefilter: 0,
    rowsPassingIsbnPrefilter: 0,
    authorLookupsPerformed: 0,
    matchedEditions: 0,
    canonicalCandidates: 0,
    uniqueCandidateAssociations: 0,
    requestedWorksWithCandidates: 0,
    requestedWorksWithoutCandidates: 0,
    elapsedMs: 0,
  };

  const startTime = Date.now();

  try {
    if (!activeLookup) {
      openedLookup = await createOpenLibraryAuthorLookup({ indexPath: authorIndexPath, snapshotId: cleanSnapshotId });
      activeLookup = openedLookup;
    }

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
        artifact_format TEXT NOT NULL,
        artifact_version INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        source_manifest_fingerprint TEXT NOT NULL,
        source_manifest_count INTEGER NOT NULL,
        rows_scanned INTEGER NOT NULL,
        matched_edition_count INTEGER NOT NULL,
        candidate_association_count INTEGER NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE TABLE candidates (
        source_key TEXT NOT NULL,
        candidate_record_key TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        PRIMARY KEY (source_key, candidate_record_key)
      ) WITHOUT ROWID;
      PRAGMA user_version = ${TARGETED_ARTIFACT_VERSION};
      BEGIN IMMEDIATE;
    `);
    transactionOpen = true;

    const insertCandidate = database.prepare('INSERT OR IGNORE INTO candidates (source_key, candidate_record_key, canonical_json) VALUES (?, ?, ?)');
    const insertMetadata = database.prepare(`
      INSERT INTO metadata (
        singleton, artifact_format, artifact_version, source_name, snapshot_id,
        source_manifest_fingerprint, source_manifest_count, rows_scanned,
        matched_edition_count, candidate_association_count, generated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let pendingOperations = 0;

    for await (const record of readOpenLibraryBulkRecords(inputPath)) {
      statistics.rowsScanned += 1;

      if (record instanceof SnapshotRecordError) {
        statistics.malformedRows += 1;
        continue;
      }
      if (!record || record.type !== '/type/edition' || !plainObject(record.data)) {
        statistics.rejectedRows += 1;
        continue;
      }

      const rawTitle = typeof record.data.title === 'string' ? record.data.title.trim() : null;
      const normalizedTitle = rawTitle ? normalizeTitle(rawTitle) : null;
      const passesTitle = Boolean(normalizedTitle && titleTargets.has(normalizedTitle));

      const isbns = isbn13Values(record.data);
      const matchingIsbnSources = new Map();
      for (const isbn of isbns.values) {
        const matchingSources = isbnTargets.get(isbn);
        if (matchingSources?.length) {
          matchingIsbnSources.set(isbn, matchingSources);
        }
      }
      const passesIsbn = matchingIsbnSources.size > 0;

      if (passesTitle) statistics.rowsPassingTitlePrefilter += 1;
      if (passesIsbn) statistics.rowsPassingIsbnPrefilter += 1;

      if (!passesTitle && !passesIsbn) {
        continue;
      }

      const authorKeys = Array.isArray(record.data.authors)
        ? [...new Set(record.data.authors.map(item => (typeof item?.key === 'string' && item.key.trim() ? item.key.trim() : null)).filter(Boolean))]
        : [];

      let resolvedAuthors = null;
      if (authorKeys.length > 0) {
        statistics.authorLookupsPerformed += 1;
        resolvedAuthors = await authorNames(activeLookup, authorKeys);
      }

      const matchingTitleSources = [];
      if (passesTitle && resolvedAuthors?.length > 0) {
        const candidatePrimaryAuthor = normalizeAuthorName(resolvedAuthors[0]);
        const candidatesForTitle = titleTargets.get(normalizedTitle) ?? [];
        for (const source of candidatesForTitle) {
          if (normalizeAuthorName(source.author) === candidatePrimaryAuthor) {
            matchingTitleSources.push(source);
          }
        }
      }

      if (matchingTitleSources.length === 0 && !passesIsbn) {
        continue;
      }

      statistics.matchedEditions += 1;

      const editionCandidates = [];
      for await (const item of mapOpenLibraryEditionRecord(record, { snapshotId: cleanSnapshotId, authorLookup: activeLookup, authors: resolvedAuthors })) {
        if (item instanceof SnapshotRecordError) {
          continue;
        }
        editionCandidates.push(item);
      }

      if (!editionCandidates.length) {
        continue;
      }

      statistics.canonicalCandidates += editionCandidates.length;

      const associations = new Map();

      for (const source of matchingTitleSources) {
        let sourceMap = associations.get(source.key);
        if (!sourceMap) {
          sourceMap = new Map();
          associations.set(source.key, sourceMap);
        }
        for (const cand of editionCandidates) {
          sourceMap.set(recordKey(cand), cand);
        }
      }

      for (const [matchedIsbn, sources] of matchingIsbnSources) {
        const matchedCand = editionCandidates.find(c => c.isbn13 === matchedIsbn);
        if (!matchedCand) continue;
        const rKey = recordKey(matchedCand);
        for (const source of sources) {
          let sourceMap = associations.get(source.key);
          if (!sourceMap) {
            sourceMap = new Map();
            associations.set(source.key, sourceMap);
          }
          sourceMap.set(rKey, matchedCand);
        }
      }

      for (const [sourceKey, candidateMap] of associations) {
        for (const [candidateRecordKey, candidate] of candidateMap) {
          const info = insertCandidate.run(sourceKey, candidateRecordKey, stableJson(candidate));
          if (info.changes > 0) {
            statistics.uniqueCandidateAssociations += 1;
            pendingOperations += 1;
          }
        }
      }

      if (pendingOperations >= batchSize) {
        database.exec('COMMIT; BEGIN IMMEDIATE;');
        pendingOperations = 0;
      }

      if (typeof onProgress === 'function' && statistics.rowsScanned % 100_000 === 0) {
        onProgress(statistics);
      }
    }

    database.exec('COMMIT;');
    transactionOpen = false;

    const worksWithCandidates = database.prepare('SELECT COUNT(DISTINCT source_key) AS count FROM candidates').get().count;
    statistics.requestedWorksWithCandidates = worksWithCandidates;
    statistics.requestedWorksWithoutCandidates = sourceEntries.length - worksWithCandidates;
    statistics.elapsedMs = Date.now() - startTime;

    database.exec('PRAGMA locking_mode = NORMAL; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
    transactionOpen = true;
    const generatedAt = new Date().toISOString();
    insertMetadata.run(
      TARGETED_ARTIFACT_FORMAT,
      TARGETED_ARTIFACT_VERSION,
      OPEN_LIBRARY_BULK_SOURCE,
      cleanSnapshotId,
      manifestFp,
      sourceEntries.length,
      statistics.rowsScanned,
      statistics.matchedEditions,
      statistics.uniqueCandidateAssociations,
      generatedAt,
    );
    database.exec('COMMIT;');
    transactionOpen = false;
    database.exec('PRAGMA optimize;');
    database.close();
    database = null;

    await validateBuiltTargetedArtifact(tempPath, {
      expectedSnapshotId: cleanSnapshotId,
      expectedManifestFingerprint: manifestFp,
      expectedCount: sourceEntries.length,
      expectedAssociations: statistics.uniqueCandidateAssociations,
    });

    await replaceArtifactFile(tempPath, finalPath);

    return {
      format: TARGETED_ARTIFACT_FORMAT,
      artifactVersion: TARGETED_ARTIFACT_VERSION,
      sourceName: OPEN_LIBRARY_BULK_SOURCE,
      snapshotId: cleanSnapshotId,
      sourceManifestFingerprint: manifestFp,
      sourceManifestCount: sourceEntries.length,
      outputPath: finalPath,
      statistics,
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
    if (openedLookup && typeof openedLookup.close === 'function') {
      try { openedLookup.close(); } catch {}
    }
  }
}

export async function createTargetedCanonicalAdapter({
  artifactPath,
  expectedSnapshotId = null,
  expectedManifestFingerprint = null,
  sourceManifest = null,
}) {
  const path = resolve(artifactPath);
  const metadata = await readTargetedArtifactMetadata(path);

  if (expectedSnapshotId && metadata.snapshotId !== expectedSnapshotId) {
    fail('snapshot_identity_mismatch', `Targeted artifact snapshotId (${metadata.snapshotId}) does not match expected snapshot (${expectedSnapshotId})`);
  }

  const expectedFingerprint = expectedManifestFingerprint ?? (sourceManifest ? manifestFingerprint(sourceManifest) : null);
  if (expectedFingerprint && metadata.sourceManifestFingerprint !== expectedFingerprint) {
    fail('source_manifest_mismatch', 'Targeted artifact source manifest fingerprint does not match requested source manifest');
  }

  const { DatabaseSync } = await sqlite();
  const database = new DatabaseSync(path, { readOnly: true });
  const selectCandidates = database.prepare('SELECT candidate_record_key, canonical_json FROM candidates WHERE source_key = ?');
  let closed = false;

  return {
    sourceName: metadata.sourceName,
    metadata,
    async getCandidates(sourceValue) {
      const source = validateSourceEntry(sourceValue);
      const rows = selectCandidates.all(source.key);
      const candidates = [];
      const exactIsbn = source.pinnedIsbn13 ?? source.preferredIsbn13 ?? null;
      for (const row of rows) {
        let parsed;
        try {
          parsed = JSON.parse(row.canonical_json);
        } catch {
          fail('corrupt_targeted_artifact', `Invalid JSON in candidate row for source ${source.key}`);
        }
        const candidate = validateCanonicalCandidate(parsed);
        candidates.push({ candidate, recordKey: row.candidate_record_key });
      }
      return candidates.sort((left, right) => {
        const leftExact = exactIsbn && left.candidate.isbn13 === exactIsbn ? 1 : 0;
        const rightExact = exactIsbn && right.candidate.isbn13 === exactIsbn ? 1 : 0;
        const exactOrder = rightExact - leftExact;
        return exactOrder
          || left.candidate.isbn13.localeCompare(right.candidate.isbn13)
          || left.candidate.title.localeCompare(right.candidate.title)
          || left.candidate.authors.join('\u0000').localeCompare(right.candidate.authors.join('\u0000'))
          || left.recordKey.localeCompare(right.recordKey);
      }).map(item => item.candidate);
    },
    close() {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  };
}
