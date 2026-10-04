import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import generated from '../../src/generated/prisma/index.js';
import { serializable } from '../../src/lib/transaction.js';
import { writeFileAtomic } from './atomic-write.js';
import {
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  validateResolvedArtifact,
} from './contracts.js';
import {
  candidateTitleAuthorKey,
  createReadOnlyPrismaClient,
  isValidOpenLibraryWorkKey,
  normalizeCandidateIsbns,
  readDedupReport,
} from './dedup-check.js';
import { validateEnrichedArtifact } from './enrich.js';
import { stableJson } from './external-sort.js';
import { pilotDisqualificationReason } from './pilot-planner.js';
import { workIdentity } from './work-identity.js';

const CONTROLLED_GENRE_SLUGS = new Set([
  'fantasy', 'science-fiction', 'mystery', 'romance', 'history', 'biography',
  'science', 'philosophy', 'poetry', 'children', 'fiction',
]);

function isOpenLibraryCover(value) {
  try { return new URL(value).hostname === 'covers.openlibrary.org'; }
  catch { return false; }
}

function isGoogleBooksCover(value) {
  try { return ['books.google.com', 'books.googleusercontent.com', 'lh3.googleusercontent.com'].includes(new URL(value).hostname); }
  catch { return false; }
}

export function validateImportArtifact(value) {
  const artifact = validateResolvedArtifact(value);
  if (artifact.resolverVersion !== CATALOG_RESOLVER_VERSION
    || artifact.entries.some(entry => entry.resolverVersion !== CATALOG_RESOLVER_VERSION)) {
    throw new CatalogContractError('stale_artifact', `Catalog artifact must use resolver version ${CATALOG_RESOLVER_VERSION}`);
  }
  const unsupported = artifact.entries
    .filter(entry => entry.status === 'resolved')
    .flatMap(entry => entry.metadata.genres)
    .find(genre => !CONTROLLED_GENRE_SLUGS.has(genre.slug));
  if (unsupported) throw new CatalogContractError('unsupported_genre', `Unsupported catalog genre ${unsupported.slug}`);
  return artifact;
}

function importFields(metadata, existing) {
  const fields = { title: metadata.title, author: metadata.author };
  for (const key of ['publicationYear', 'description', 'coverImageUrl']) {
    const value = metadata[key];
    if (value === null) continue;
    if (key === 'coverImageUrl' && isGoogleBooksCover(value) && isOpenLibraryCover(existing?.coverImageUrl)) continue;
    fields[key] = value;
  }
  return fields;
}

async function inspectBook(db, metadata) {
  const existing = await db.book.findUnique({
    where: { isbn: metadata.isbn },
    include: { bookGenres: { include: { genre: true } } },
  });
  const fields = importFields(metadata, existing);
  const changes = existing
    ? Object.fromEntries(Object.entries(fields).filter(([key, value]) => existing[key] !== value))
    : fields;
  const existingSlugs = new Set(existing?.bookGenres.map(row => row.genre.slug) ?? []);
  const additions = metadata.genres.filter(genre => !existingSlugs.has(genre.slug));
  const outcome = !existing ? 'created' : Object.keys(changes).length || additions.length ? 'updated' : 'unchanged';
  return { existing, fields, changes, additions, outcome };
}

async function applyBook(db, metadata) {
  return serializable(db, async tx => {
    const inspected = await inspectBook(tx, metadata);
    if (inspected.outcome === 'unchanged') return inspected.outcome;
    const book = inspected.existing
      ? await tx.book.update({ where: { id: inspected.existing.id }, data: inspected.changes })
      : await tx.book.create({ data: { isbn: metadata.isbn, ...inspected.fields } });
    for (const item of inspected.additions) {
      const genre = await tx.genre.upsert({ where: { slug: item.slug }, create: item, update: {} });
      await tx.bookGenre.upsert({
        where: { bookId_genreId: { bookId: book.id, genreId: genre.id } },
        create: { bookId: book.id, genreId: genre.id },
        update: {},
      });
    }
    return inspected.outcome;
  });
}

export async function importResolvedCatalog(db, artifactValue, { apply, report = () => {} } = {}) {
  if (typeof apply !== 'boolean') throw new TypeError('apply must be true or false');
  const artifact = validateImportArtifact(artifactValue);
  const resolved = artifact.entries.filter(entry => entry.status === 'resolved');
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: artifact.entries.length - resolved.length,
    failed: 0,
    resolved: resolved.length,
  };
  for (const entry of resolved) {
    try {
      const outcome = apply ? await applyBook(db, entry.metadata) : (await inspectBook(db, entry.metadata)).outcome;
      summary[outcome]++;
    } catch (error) {
      summary.failed++;
      report(`${entry.key}: failed (${error?.message ?? String(error)})`);
    }
  }
  return summary;
}

export const CATALOG_IMPORT_DEFAULT_LIMIT = 500;
export const CATALOG_IMPORT_MAX_LIMIT = 10_000;
export const CATALOG_IMPORT_DEFAULT_BATCH_SIZE = 100;
export const CATALOG_IMPORT_TITLE_MAX_LENGTH = 500;
export const CATALOG_IMPORT_AUTHOR_MAX_LENGTH = 300;
export const CATALOG_IMPORT_SKIP_REASONS = Object.freeze([
  'existing',
  'ambiguous',
  'missing_title',
  'missing_author',
  'unsupported_script',
  'audiobook',
  'ebook',
  'large_print',
  'boxed_set',
  'calendar',
  'journal',
  'cards',
  'non_book',
  'duplicate_work_key',
  'duplicate_isbn',
  'limit',
]);

const ISBN13_FORMAT = /^[0-9]{13}$/;
const IMPORT_ACTIONS = new Set(['insert', 'plan', 'skip', 'fail']);
const DEDUP_STATUSES = new Set(['new', 'existing', 'ambiguous']);

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function importFail(code, message) {
  throw new CatalogContractError(code, message);
}

function stripUnsafeCharacters(value) {
  let cleaned = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cleaned += value[index] + value[index + 1];
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    cleaned += value[index];
  }
  return cleaned;
}

function displayText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const cleaned = stripUnsafeCharacters(value).trim().replace(/\s+/g, ' ');
  const points = [...cleaned];
  if (points.length <= maxLength) return cleaned;
  return points.slice(0, maxLength).join('');
}

function displayTitle(value) {
  return displayText(value, CATALOG_IMPORT_TITLE_MAX_LENGTH);
}

function displayAuthor(value) {
  return displayText(value, CATALOG_IMPORT_AUTHOR_MAX_LENGTH);
}

function unsupportedScriptTitle(title) {
  if (!/\p{L}/u.test(title)) return false;
  return !/\p{Script=Latin}/u.test(title.normalize('NFKD'));
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

export function importLimit(value = CATALOG_IMPORT_DEFAULT_LIMIT) {
  return boundedInteger(value, '--limit', CATALOG_IMPORT_MAX_LIMIT);
}

export function importBatchSize(value = CATALOG_IMPORT_DEFAULT_BATCH_SIZE) {
  return boundedInteger(value, '--batch-size', CATALOG_IMPORT_MAX_LIMIT);
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

export function lowestImportIsbn(candidate) {
  let lowest = null;
  for (const isbn of normalizeCandidateIsbns(candidate ?? {})) {
    if (!ISBN13_FORMAT.test(isbn)) continue;
    if (lowest === null || isbn < lowest) lowest = isbn;
  }
  return lowest;
}

export function importCoverImageUrl(candidate) {
  const coverIds = Array.isArray(candidate?.coverIds) ? candidate.coverIds : [];
  const cover = coverIds.find(id => Number.isSafeInteger(id) && id > 0);
  if (!cover) return null;
  return `https://covers.openlibrary.org/b/id/${cover}-L.jpg?default=false`;
}

export function importPublicationYear(candidate) {
  if (!candidate || !Object.hasOwn(candidate, 'publicationYear') || candidate.publicationYear === null) return null;
  const year = candidate.publicationYear;
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  return year;
}

export function candidateImportSkipReason(candidate) {
  const title = displayTitle(candidate?.title);
  if (!title) return 'missing_title';
  const author = displayAuthor(candidate?.primaryAuthor);
  if (!author) return 'missing_author';
  const normalized = { title, primaryAuthor: author };
  if (candidateTitleAuthorKey(normalized)) return null;
  const [titleKey, authorKey] = workIdentity({ title, author }).split('\u0000');
  if (!titleKey) return unsupportedScriptTitle(title) ? 'unsupported_script' : 'missing_title';
  if (!authorKey) return 'missing_author';
  return 'missing_author';
}

export function mapCandidateToBook(candidate) {
  const skip = candidateImportSkipReason(candidate);
  if (skip) return { skip };
  if (!isValidOpenLibraryWorkKey(candidate.workKey)) importFail('invalid_dedup_report', 'Import candidate work key is invalid');
  const publicationYear = importPublicationYear(candidate);
  const book = {
    title: displayTitle(candidate.title),
    author: displayAuthor(candidate.primaryAuthor),
    isbn: lowestImportIsbn(candidate),
    openLibraryWorkKey: candidate.workKey,
    coverImageUrl: importCoverImageUrl(candidate),
  };
  if (publicationYear !== null) book.publicationYear = publicationYear;
  return { book };
}

function validateReportRow(row, index, snapshotId) {
  if (!plainObject(row)) importFail('invalid_dedup_report', `Dedup report line ${index + 1} is malformed`);
  if (!isValidOpenLibraryWorkKey(row.workKey)) {
    importFail('invalid_dedup_report', `Dedup report line ${index + 1} work key is invalid`);
  }
  if (typeof row.title !== 'string') importFail('invalid_dedup_report', `Dedup report line ${index + 1} title is invalid`);
  if (!DEDUP_STATUSES.has(row.status)) importFail('invalid_dedup_report', `Dedup report line ${index + 1} status is invalid`);
  if (!Array.isArray(row.matchedBookIds) || row.matchedBookIds.some(id => typeof id !== 'string')) {
    importFail('invalid_dedup_report', `Dedup report line ${index + 1} matchedBookIds is invalid`);
  }
  if (row.matchedBy !== null && typeof row.matchedBy !== 'string') {
    importFail('invalid_dedup_report', `Dedup report line ${index + 1} matchedBy is invalid`);
  }
  if (Object.hasOwn(row, 'snapshotId') && row.snapshotId !== snapshotId) {
    importFail('snapshot_mismatch', `Dedup report line ${index + 1} snapshotId does not match enriched snapshot ${snapshotId}`);
  }
}

function artifactForJoin(artifact) {
  if (plainObject(artifact) && artifact.languageCheck === 'passed') {
    return { ...artifact, languageCheck: 'pending' };
  }
  return artifact;
}

export function joinReportToEnriched(reportRows, artifact) {
  if (!Array.isArray(reportRows)) importFail('invalid_dedup_report', 'Dedup report must be a list of rows');
  const validated = validateEnrichedArtifact(artifactForJoin(artifact));
  if (reportRows.length !== validated.candidates.length) {
    importFail('snapshot_mismatch', `Dedup report does not match enriched snapshot ${validated.snapshotId}`);
  }
  const byKey = new Map(validated.candidates.map(candidate => [candidate.workKey, candidate]));
  const seen = new Set();
  const joined = [];
  for (let index = 0; index < reportRows.length; index += 1) {
    const row = reportRows[index];
    validateReportRow(row, index, validated.snapshotId);
    if (seen.has(row.workKey)) importFail('invalid_dedup_report', `Dedup report repeats work key ${row.workKey}`);
    seen.add(row.workKey);
    const candidate = byKey.get(row.workKey);
    if (!candidate || candidate.title !== row.title) {
      importFail('snapshot_mismatch', `Dedup report line ${index + 1} does not match enriched snapshot ${validated.snapshotId}`);
    }
    joined.push({ row, candidate });
  }
  return { snapshotId: validated.snapshotId, joined };
}

export async function loadWorksImportSources(reportPath, enrichedPath) {
  const report = resolve(reportPath);
  const enriched = resolve(enrichedPath);
  let reportRows;
  try {
    reportRows = await readDedupReport(report);
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw cause;
    importFail('invalid_dedup_report', `Unable to read dedup report ${report}: ${cause.message}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(await fs.readFile(enriched, 'utf8'));
  } catch (cause) {
    importFail('invalid_enriched_artifact', `Unable to read enriched artifact ${enriched}: ${cause.message}`);
  }
  joinReportToEnriched(reportRows, artifact);
  return { reportRows, artifact };
}

function resultRow(workKey, action, reason = null, error = null) {
  return { workKey, action, reason, error };
}

function errorText(error) {
  const message = error?.message ?? String(error);
  return message.length > 500 ? message.slice(0, 500) : message;
}

function classifyBatch(books, existingBooks, seen = { workKeys: new Set(), isbns: new Set() }) {
  const workKeys = new Set(seen.workKeys);
  const isbns = new Set(seen.isbns);
  for (const book of existingBooks) {
    if (isValidOpenLibraryWorkKey(book.openLibraryWorkKey)) workKeys.add(book.openLibraryWorkKey);
    if (typeof book.isbn === 'string' && ISBN13_FORMAT.test(book.isbn)) isbns.add(book.isbn);
  }
  const skipped = [];
  const insert = [];
  const seenKeys = new Set();
  const seenIsbns = new Set();
  for (const book of books) {
    if (workKeys.has(book.openLibraryWorkKey) || seenKeys.has(book.openLibraryWorkKey)) {
      skipped.push({ book, reason: 'duplicate_work_key' });
      continue;
    }
    if (book.isbn && (isbns.has(book.isbn) || seenIsbns.has(book.isbn))) {
      skipped.push({ book, reason: 'duplicate_isbn' });
      continue;
    }
    seenKeys.add(book.openLibraryWorkKey);
    if (book.isbn) seenIsbns.add(book.isbn);
    insert.push(book);
  }
  return { skipped, insert };
}

async function findExistingBooks(db, books) {
  const workKeys = [...new Set(books.map(book => book.openLibraryWorkKey))];
  const isbns = [...new Set(books.map(book => book.isbn).filter(isbn => typeof isbn === 'string' && ISBN13_FORMAT.test(isbn)))];
  const or = [{ openLibraryWorkKey: { in: workKeys } }];
  if (isbns.length) or.push({ isbn: { in: isbns } });
  return db.book.findMany({
    where: { OR: or },
    select: { id: true, isbn: true, openLibraryWorkKey: true },
  });
}

function toBookCreateData(book) {
  const data = {
    id: randomUUID(),
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    openLibraryWorkKey: book.openLibraryWorkKey,
    coverImageUrl: book.coverImageUrl,
    ratingsCount: 0,
    updatedAt: new Date(),
  };
  if (book.publicationYear != null) data.publicationYear = book.publicationYear;
  return data;
}

async function confirmInserted(tx, books) {
  if (!books.length) return { inserted: [], skipped: [] };
  const found = await tx.book.findMany({
    where: { openLibraryWorkKey: { in: books.map(book => book.openLibraryWorkKey) } },
    select: { openLibraryWorkKey: true },
  });
  const foundKeys = new Set(found.map(book => book.openLibraryWorkKey));
  const inserted = [];
  const skipped = [];
  for (const book of books) {
    if (foundKeys.has(book.openLibraryWorkKey)) inserted.push(book);
    else skipped.push({ book, reason: 'duplicate_isbn' });
  }
  return { inserted, skipped };
}

async function runImportBatch({ db, batch, apply, afterBatchInsert, index, seen }) {
  const books = batch.map(item => item.book);
  if (!apply) {
    const existing = await findExistingBooks(db, books);
    const classified = classifyBatch(books, existing, seen);
    return { skipped: classified.skipped, accepted: classified.insert };
  }
  return db.$transaction(async tx => {
    const existing = await findExistingBooks(tx, books);
    const classified = classifyBatch(books, existing, seen);
    if (classified.insert.length) {
      await tx.book.createMany({
        data: classified.insert.map(toBookCreateData),
        skipDuplicates: true,
      });
    }
    if (afterBatchInsert) await afterBatchInsert({ index, tx, books: classified.insert });
    const confirmed = await confirmInserted(tx, classified.insert);
    return {
      skipped: [...classified.skipped, ...confirmed.skipped],
      accepted: confirmed.inserted,
    };
  }, { timeout: 15000 });
}

export function buildImportSummary({
  rows,
  mode,
  snapshotId,
  limit,
  batchSize,
  batches,
  languageCheck = null,
  report = null,
}) {
  const skipped = Object.fromEntries(CATALOG_IMPORT_SKIP_REASONS.map(reason => [reason, 0]));
  const errors = [];
  let planned = 0;
  let inserted = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.action === 'plan') planned += 1;
    else if (row.action === 'insert') inserted += 1;
    else if (row.action === 'fail') {
      failed += 1;
      errors.push({ workKey: row.workKey, error: row.error });
    } else if (row.action === 'skip') {
      if (!Object.hasOwn(skipped, row.reason)) importFail('invalid_import_report', `Unknown skip reason ${row.reason}`);
      skipped[row.reason] += 1;
    } else {
      importFail('invalid_import_report', `Unknown import action ${row.action}`);
    }
  }
  return {
    mode,
    snapshotId,
    languageCheck,
    limit,
    batchSize,
    batches,
    planned,
    inserted: mode === 'dry-run' ? 0 : inserted,
    skipped,
    failed,
    errors,
    report,
  };
}

function assertImportRow(row, index) {
  if (!plainObject(row)) importFail('invalid_import_report', `Import report line ${index + 1} is malformed`);
  const keys = ['workKey', 'action', 'reason', 'error'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) {
    importFail('invalid_import_report', `Import report line ${index + 1} is malformed`);
  }
  if (!isValidOpenLibraryWorkKey(row.workKey)) importFail('invalid_import_report', `Import report line ${index + 1} work key is invalid`);
  if (!IMPORT_ACTIONS.has(row.action)) importFail('invalid_import_report', `Import report line ${index + 1} action is invalid`);
  if (row.action === 'skip') {
    if (!CATALOG_IMPORT_SKIP_REASONS.includes(row.reason) || row.error !== null) {
      importFail('invalid_import_report', `Import report line ${index + 1} skip is malformed`);
    }
  } else if (row.action === 'fail') {
    if (row.reason !== 'batch_failed' || typeof row.error !== 'string' || !row.error) {
      importFail('invalid_import_report', `Import report line ${index + 1} failure is malformed`);
    }
  } else if (row.reason !== null || row.error !== null) {
    importFail('invalid_import_report', `Import report line ${index + 1} result is malformed`);
  }
}

function parseJsonl(content) {
  return content.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
}

function assertReportConsistent(rows, summary) {
  rows.forEach(assertImportRow);
  if (summary.mode === 'dry-run' && rows.some(row => row.action === 'insert')) {
    importFail('invalid_import_report', 'Dry-run report records an insert');
  }
  if (summary.mode === 'apply' && rows.some(row => row.action === 'plan')) {
    importFail('invalid_import_report', 'Apply report records a planned row');
  }
  const rebuilt = buildImportSummary({
    rows,
    mode: summary.mode,
    snapshotId: summary.snapshotId,
    limit: summary.limit,
    batchSize: summary.batchSize,
    batches: summary.batches,
    languageCheck: summary.languageCheck ?? null,
    report: summary.report ?? null,
  });
  if (stableJson(rebuilt) !== stableJson(summary)) {
    importFail('invalid_import_report', 'Import summary does not match the JSONL rows');
  }
}

export function catalogImportSummaryPath(outputPath) {
  const resolved = resolve(outputPath);
  if (resolved.endsWith('.jsonl')) return `${resolved.slice(0, -'.jsonl'.length)}.summary.json`;
  return `${resolved}.summary.json`;
}

export async function writeCatalogImportReport(outputPath, { rows, summary }) {
  const resolved = resolve(outputPath);
  const lines = rows.map(row => `${JSON.stringify(row)}\n`).join('');
  const recorded = {
    ...summary,
    languageCheck: summary.languageCheck ?? null,
    report: summary.report ?? resolved,
  };
  // The summary is written after the JSONL report and names that report path.
  await writeFileAtomic(resolved, lines, {
    mode: 0o600,
    validate: async content => {
      let parsed;
      try { parsed = parseJsonl(content); }
      catch { importFail('invalid_import_report', 'Import report JSONL did not round-trip'); }
      if (stableJson(parsed) !== stableJson(rows)) importFail('invalid_import_report', 'Import report JSONL did not round-trip');
      parsed.forEach(assertImportRow);
    },
  });
  const summaryPath = catalogImportSummaryPath(resolved);
  await writeFileAtomic(summaryPath, `${JSON.stringify(recorded, null, 2)}\n`, {
    mode: 0o600,
    validate: async content => {
      let parsed;
      try { parsed = JSON.parse(content); }
      catch { importFail('invalid_import_report', 'Import summary is not valid JSON'); }
      assertReportConsistent(rows, parsed);
      if (stableJson(parsed) !== stableJson(recorded)) importFail('invalid_import_report', 'Import summary did not round-trip');
    },
  });
  return { outputPath: resolved, summaryPath };
}

function assertApplyLanguage(artifact, { apply, allowUncheckedLanguage }) {
  const languageCheck = artifact?.languageCheck ?? null;
  if (!apply) return languageCheck;
  if (languageCheck !== 'passed' && !allowUncheckedLanguage) {
    throw new Error(`Refusing --apply because languageCheck is ${JSON.stringify(languageCheck)}, not "passed". Pass --allow-unchecked-language to apply anyway.`);
  }
  if (allowUncheckedLanguage) {
    console.error(`WARNING: --allow-unchecked-language is set. Applying catalog works with languageCheck ${JSON.stringify(languageCheck)} instead of requiring "passed".`);
  }
  return languageCheck;
}

export async function importCatalogWorks({
  db,
  reportRows,
  artifact,
  apply = false,
  allowUncheckedLanguage = false,
  limit = CATALOG_IMPORT_DEFAULT_LIMIT,
  batchSize = CATALOG_IMPORT_DEFAULT_BATCH_SIZE,
  outputPath = null,
  afterBatchInsert = null,
} = {}) {
  if (typeof apply !== 'boolean') throw new TypeError('apply must be true or false');
  if (typeof allowUncheckedLanguage !== 'boolean') throw new TypeError('allowUncheckedLanguage must be true or false');
  const boundedLimit = importLimit(limit);
  const boundedBatch = importBatchSize(batchSize);
  const { snapshotId, joined } = joinReportToEnriched(reportRows, artifact);
  const languageCheck = assertApplyLanguage(artifact, { apply, allowUncheckedLanguage });
  const resultsByKey = new Map();
  const selected = [];
  for (const { row, candidate } of joined) {
    if (row.status === 'existing' || row.status === 'ambiguous') {
      resultsByKey.set(row.workKey, resultRow(row.workKey, 'skip', row.status));
      continue;
    }
    const mapped = mapCandidateToBook(candidate);
    if (mapped.skip) {
      resultsByKey.set(row.workKey, resultRow(row.workKey, 'skip', mapped.skip));
      continue;
    }
    const disqualified = pilotDisqualificationReason(candidate);
    if (disqualified) {
      resultsByKey.set(row.workKey, resultRow(row.workKey, 'skip', disqualified));
      continue;
    }
    if (selected.length >= boundedLimit) {
      resultsByKey.set(row.workKey, resultRow(row.workKey, 'skip', 'limit'));
      continue;
    }
    selected.push({ workKey: row.workKey, book: mapped.book });
  }
  const batches = chunk(selected, boundedBatch);
  const seen = { workKeys: new Set(), isbns: new Set() };
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    try {
      const outcome = await runImportBatch({
        db,
        batch,
        apply,
        afterBatchInsert: apply ? afterBatchInsert : null,
        index,
        seen,
      });
      for (const item of outcome.skipped) {
        resultsByKey.set(item.book.openLibraryWorkKey, resultRow(item.book.openLibraryWorkKey, 'skip', item.reason));
      }
      for (const book of outcome.accepted) {
        seen.workKeys.add(book.openLibraryWorkKey);
        if (book.isbn) seen.isbns.add(book.isbn);
        resultsByKey.set(book.openLibraryWorkKey, resultRow(book.openLibraryWorkKey, apply ? 'insert' : 'plan'));
      }
    } catch (error) {
      const message = errorText(error);
      for (const item of batch) {
        resultsByKey.set(item.workKey, resultRow(item.workKey, 'fail', 'batch_failed', message));
      }
    }
  }
  const rows = joined.map(({ row }) => {
    const result = resultsByKey.get(row.workKey);
    if (!result) throw new Error(`Missing import result for ${row.workKey}`);
    return result;
  });
  const summary = buildImportSummary({
    rows,
    mode: apply ? 'apply' : 'dry-run',
    snapshotId,
    languageCheck,
    limit: boundedLimit,
    batchSize: boundedBatch,
    batches: batches.length,
    report: outputPath ? resolve(outputPath) : null,
  });
  if (outputPath) await writeCatalogImportReport(outputPath, { rows, summary });
  return { rows, summary, exitCode: summary.failed > 0 ? 1 : 0 };
}

function requireOptionValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseCatalogWorksImportArgs(args) {
  const options = {
    report: null,
    enriched: null,
    output: null,
    apply: false,
    allowUncheckedLanguage: false,
    limit: CATALOG_IMPORT_DEFAULT_LIMIT,
    batchSize: CATALOG_IMPORT_DEFAULT_BATCH_SIZE,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      if (seen.has(argument)) throw new Error('--apply was provided more than once');
      seen.add(argument);
      options.apply = true;
      continue;
    }
    if (argument === '--allow-unchecked-language') {
      if (seen.has(argument)) throw new Error('--allow-unchecked-language was provided more than once');
      seen.add(argument);
      options.allowUncheckedLanguage = true;
      continue;
    }
    if (argument === '--dry-run' || argument === '--artifact') {
      throw new Error(`${argument} belongs to the resolved-artifact importer. Omit --apply to plan the works import without writing`);
    }
    if (argument === '--report' || argument === '--enriched' || argument === '--output' || argument === '--limit' || argument === '--batch-size') {
      if (seen.has(argument)) throw new Error(`${argument} was provided more than once`);
      seen.add(argument);
      const value = requireOptionValue(args, index + 1, argument);
      index += 1;
      if (argument === '--report') options.report = resolve(value);
      else if (argument === '--enriched') options.enriched = resolve(value);
      else if (argument === '--output') options.output = resolve(value);
      else if (argument === '--limit') options.limit = importLimit(Number(value));
      else options.batchSize = importBatchSize(Number(value));
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.report || !options.enriched || !options.output) {
    throw new Error('--report, --enriched, and --output are required');
  }
  return options;
}

export async function assertOutputDirectoryWritable(outputPath) {
  const directory = dirname(resolve(outputPath));
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fsConstants.W_OK);
  } catch {
    throw new Error(`Import output directory is not writable: ${directory}`);
  }
}

export function createImportPrismaClient(databaseUrl, { apply }) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!apply) return createReadOnlyPrismaClient(databaseUrl);
  return new generated.PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: 10 }),
  });
}
