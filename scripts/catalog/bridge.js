import * as fs from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { mapGenres } from '../catalog.js';
import { assertOutputDirectoryWritable, writeFileAtomic } from './atomic-write.js';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  sourceFingerprint,
} from './contracts.js';
import { stableJson } from './external-sort.js';
import {
  candidateImportSkipReason,
  computeReportDigestMatch,
  importLimit,
  joinReportToEnriched,
  loadWorksImportSources,
  validateImportArtifact,
} from './import.js';
import { validateLanguageCheckedArtifact } from './language-check.js';
import { createOpenLibraryAuthorLookup, mapOpenLibraryEditionRecord, readOpenLibraryBulkRecords } from './open-library-bulk.js';
import { adaptCanonicalCandidateForScoring, pilotDisqualificationReason } from './pilot-planner.js';
import { selectEdition } from './score-editions.js';
import { SnapshotRecordError } from './snapshot-reader.js';
import { workIdentity } from './work-identity.js';

function fail(code, message) {
  throw new CatalogContractError(code, message);
}

function baseEntry(candidate) {
  // Missing-author entries have diagnostics only; this fallback is never imported as metadata.
  const source = {
    key: `open-library-${candidate.workKey.slice('/works/'.length).toLowerCase()}`,
    title: candidate.title,
    author: candidate.primaryAuthor ?? 'Unknown author',
  };
  return { key: source.key, sourceFingerprint: sourceFingerprint(source), resolverVersion: CATALOG_RESOLVER_VERSION };
}

function review(candidate, code) {
  return {
    ...baseEntry(candidate), status: 'needs_review',
    diagnostic: { provider: null, stage: 'bridge', code, message: `Work ${candidate.workKey} requires review: ${code}`, retryable: false, attempts: 0 },
  };
}

function resolvedEntry(candidate, selection, languageCheckDigest) {
  const edition = selection.selected._canonical;
  const coverId = edition.cover?.reference?.match(/^open_library_cover_id:(\d+)$/)?.[1];
  const workCover = candidate.coverIds.find(id => Number.isSafeInteger(id) && id > 0);
  const coverImageUrl = edition.cover?.url ?? (coverId || workCover ? `https://covers.openlibrary.org/b/id/${coverId ?? workCover}-L.jpg?default=false` : null);
  const genres = mapGenres(edition.subjects);
  return {
    ...baseEntry(candidate), status: 'resolved', diagnostic: null,
    metadata: {
      isbn: selection.isbn, title: edition.title, author: edition.authors.join(', '),
      publicationYear: edition.publicationYear, description: edition.description, coverImageUrl, genres,
    },
    providerIds: {
      openLibraryWork: candidate.workKey,
      openLibraryEdition: edition.sourceIdentifiers.openLibraryEdition,
      googleBooksVolume: null,
    },
    provenance: {
      title: 'open_library_edition',
      author: 'open_library_author_index',
      publicationYear: edition.publicationYear === null ? null : 'open_library_edition',
      description: edition.description === null ? null : 'open_library_edition',
      coverImageUrl: coverImageUrl === null ? null : coverId || edition.cover?.url ? 'open_library_edition' : 'open_library_work',
      genres: genres.length ? 'open_library_edition' : null,
    },
    selection: { score: selection.score, reasons: [...selection.reasons, `bridge_snapshot:${edition.snapshotId}`, `bridge_language_check:${languageCheckDigest}`] },
  };
}

// Validate the entire input pair before scanning editions or opening an author index.
export function validateBridgeSources(reportRows, artifact) {
  validateLanguageCheckedArtifact(artifact);
  const join = joinReportToEnriched(reportRows, artifact);
  if (computeReportDigestMatch(reportRows, artifact) !== true) {
    fail('snapshot_mismatch', 'Dedup report languageCheckDigest must match. Re-run catalog:dedup-check on the language-checked artifact.');
  }
  for (const row of reportRows) {
    const ids = row.matchedBookIds;
    if (new Set(ids).size !== ids.length || ids.some(id => !id.trim())
      || (row.status === 'new' && (ids.length !== 0 || row.matchedBy !== null))
      || (row.status === 'existing' && ids.length !== 1)
      || (row.status === 'ambiguous' && ids.length < 2)
      || (row.status !== 'new' && !['openLibraryWorkKey', 'isbn', 'titleAuthor'].includes(row.matchedBy))) {
      fail('invalid_dedup_report', `Dedup report match evidence is inconsistent for ${row.workKey}`);
    }
  }
  const candidates = new Map(artifact.candidates.map(candidate => [candidate.workKey, candidate]));
  return { ...join, joined: join.joined.map(({ row }) => ({ row, candidate: candidates.get(row.workKey) })) };
}

export async function bridgeCatalogWorks({ reportRows, artifact, records, authorLookup, limit = 500 } = {}) {
  const boundedLimit = importLimit(limit);
  const { joined } = validateBridgeSources(reportRows, artifact);
  const entries = new Map();
  const selected = new Map();
  for (const { row, candidate } of joined) {
    const reason = row.status !== 'new' ? row.status : candidateImportSkipReason(candidate)
      ?? pilotDisqualificationReason(candidate)
      ?? (!candidate.languages.includes('/languages/eng') ? 'unknown_language' : null)
      ?? (!candidate.isbns.length ? 'missing_isbn' : null)
      ?? (selected.size >= boundedLimit ? 'limit' : null);
    if (reason) entries.set(candidate.workKey, review(candidate, reason));
    else selected.set(candidate.workKey, { candidate, editions: new Map() });
  }
  const counts = { rowsScanned: 0, malformedRows: 0, rejectedEditions: 0 };
  for await (const record of records) {
    counts.rowsScanned += 1;
    if (record instanceof SnapshotRecordError) { counts.malformedRows += 1; continue; }
    if (record?.type !== '/type/edition') continue;
    const keys = [...new Set((Array.isArray(record.data?.works) ? record.data.works : []).map(ref => ref?.key).filter(key => selected.has(key)))];
    if (!keys.length) continue;
    if (!/^\/books\/OL\d+M$/.test(record.key) || record.data?.key !== record.key) {
      fail('invalid_edition_identity', 'Matched edition key does not agree with the dump record key');
    }
    for await (const edition of mapOpenLibraryEditionRecord(record, { snapshotId: artifact.snapshotId, authorLookup })) {
      if (edition instanceof SnapshotRecordError) {
        // An unavailable lookup is an operational failure, not evidence of a missing author.
        if (edition.code === 'author_lookup_error') fail('author_lookup_error', 'Unable to read edition author names');
        counts.malformedRows += 1;
        continue;
      }
      // Check the raw format too: normalization can hide a "large print paperback" cue.
      if (edition.language !== 'en' || pilotDisqualificationReason(edition)
        || pilotDisqualificationReason({ title: edition.title, subtitle: edition.subtitle, format: record.data.physical_format })) {
        counts.rejectedEditions += 1;
        continue;
      }
      for (const key of keys) {
        const target = selected.get(key);
        if (!target.candidate.isbns.includes(edition.isbn13)) continue;
        const prior = target.editions.get(edition.recordId);
        // One edition with several ISBNs is one contender; keep its lowest checked ISBN.
        if (prior) {
          const { isbn13: _priorIsbn, ...priorFields } = prior;
          const { isbn13: _isbn, ...fields } = edition;
          if (stableJson(priorFields) !== stableJson(fields)) fail('conflicting_edition', `Conflicting edition records for ${edition.recordId}`);
          if (prior.isbn13 <= edition.isbn13) continue;
        }
        target.editions.set(edition.recordId, edition);
      }
    }
  }
  const identities = new Map();
  for (const [key, { candidate, editions }] of selected) {
    const source = { key: baseEntry(candidate).key, title: candidate.title, author: candidate.primaryAuthor };
    const selection = selectEdition(source, [...editions.values()].map(adaptCanonicalCandidateForScoring));
    if (selection.status !== 'selected') { entries.set(key, review(candidate, selection.reason)); continue; }
    const entry = resolvedEntry(candidate, selection, artifact.languageCheckDigest);
    const identity = workIdentity(entry.metadata);
    const priorKey = identities.get(identity);
    if (priorKey) {
      entries.set(priorKey, review(selected.get(priorKey).candidate, 'duplicate_work'));
      entries.set(key, review(candidate, 'duplicate_work'));
    } else {
      identities.set(identity, key);
      entries.set(key, entry);
    }
  }
  const resolved = validateImportArtifact({ artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion: CATALOG_RESOLVER_VERSION, entries: joined.map(({ candidate }) => entries.get(candidate.workKey)) });
  return { artifact: resolved, summary: { snapshotId: artifact.snapshotId, ...counts, resolved: resolved.entries.filter(entry => entry.status === 'resolved').length, needsReview: resolved.entries.filter(entry => entry.status === 'needs_review').length } };
}

export async function runCatalogBridge({ reportPath, inputPath, editionsPath, authorsIndexPath, outputPath, limit = 500 } = {}) {
  for (const [name, value] of Object.entries({ reportPath, inputPath, editionsPath, authorsIndexPath, outputPath })) {
    if (typeof value !== 'string' || !value.trim()) fail('invalid_argument', `${name} is required`);
  }
  const output = resolve(outputPath);
  const authorDirectory = resolve(authorsIndexPath).toLowerCase();
  if (output.toLowerCase() === authorDirectory || output.toLowerCase().startsWith(`${authorDirectory}${sep}`)) {
    fail('invalid_argument', 'Bridge output must not overwrite the author index');
  }
  if ([reportPath, inputPath, editionsPath].some(path => resolve(path).toLowerCase() === output.toLowerCase())) {
    fail('invalid_argument', 'Bridge output must not overwrite an input');
  }
  const { reportRows, artifact } = await loadWorksImportSources(reportPath, inputPath);
  validateBridgeSources(reportRows, artifact);
  importLimit(limit);
  const editions = resolve(editionsPath);
  const stat = await fs.stat(editions);
  if (!stat.isFile() || basename(editions) !== artifact.languageCheckEditions.basename || stat.size !== artifact.languageCheckEditions.bytes) {
    fail('snapshot_mismatch', 'Editions dump basename and size must match catalog:language-check');
  }
  await assertOutputDirectoryWritable(output, { label: 'Bridge output' });
  const authorLookup = await createOpenLibraryAuthorLookup({ indexPath: authorsIndexPath, snapshotId: artifact.snapshotId });
  try {
    const result = await bridgeCatalogWorks({ reportRows, artifact, records: readOpenLibraryBulkRecords(editions), authorLookup, limit });
    await writeFileAtomic(output, `${JSON.stringify(result.artifact, null, 2)}\n`, {
      validate: content => {
        const parsed = validateImportArtifact(JSON.parse(content));
        if (stableJson(parsed) !== stableJson(result.artifact)) fail('invalid_bridge_artifact', 'Bridge artifact did not round-trip');
      },
    });
    return { ...result.summary, outputPath: output };
  } finally {
    authorLookup.close();
  }
}
