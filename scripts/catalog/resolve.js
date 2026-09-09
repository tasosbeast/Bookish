import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { mapGenres } from '../catalog.js';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  sourceFingerprint,
  validateResolvedArtifact,
  validateResolvedEntryForSource,
  validateSourceManifest,
} from './contracts.js';
import { matchWork } from './match.js';
import { normalizeIsbn13 } from './normalize.js';
import { selectEdition } from './score-editions.js';
import { CatalogProviderError } from './providers/errors.js';

export const DEFAULT_SOURCE_CONCURRENCY = 2;
const WORK_MATCH_MARGIN = 8;

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const values = value => (Array.isArray(value) ? value : []).map(text).filter(Boolean);

function diagnostic({ provider = null, stage, code, message, retryable = false, attempts = 0 }) {
  return { provider, stage, code, message, retryable, attempts };
}

function errorDiagnostic(error) {
  if (error instanceof CatalogProviderError) {
    return diagnostic({ provider: error.provider, stage: error.stage, code: error.code, message: error.message, retryable: error.retryable, attempts: error.attempts });
  }
  return diagnostic({ stage: 'resolution', code: 'execution_error', message: error?.message ?? String(error), retryable: false, attempts: 0 });
}

function entryBase(source, status, fields) {
  return {
    key: source.key,
    sourceFingerprint: sourceFingerprint(source),
    resolverVersion: CATALOG_RESOLVER_VERSION,
    status,
    ...fields,
  };
}

function reviewEntry(source, code, message, stage = 'resolution') {
  return entryBase(source, 'needs_review', { diagnostic: diagnostic({ stage, code, message }) });
}

function failedEntry(source, error) {
  return entryBase(source, 'failed', { diagnostic: errorDiagnostic(error) });
}

function candidateId(candidate) {
  return JSON.stringify(candidate?.providerIds ?? {});
}

function candidateValues(candidate, field) {
  return Array.isArray(candidate?.[field]) ? candidate[field].filter(Boolean) : [];
}

function workMetadataQuality(candidate) {
  return [
    candidate?.providerIds?.editionId ? 2 : 0,
    candidateValues(candidate, 'isbn13').length,
    candidateValues(candidate, 'languages').length,
    candidateValues(candidate, 'coverImageUrls').length,
    candidateValues(candidate, 'subjects').length,
    candidateValues(candidate, 'publicationYears').length,
    candidateValues(candidate, 'descriptions').length,
  ];
}

function compareWorkRepresentatives(left, right) {
  const leftQuality = workMetadataQuality(left.candidate);
  const rightQuality = workMetadataQuality(right.candidate);
  for (let index = 0; index < leftQuality.length; index++) {
    if (leftQuality[index] !== rightQuality[index]) return rightQuality[index] - leftQuality[index];
  }
  return candidateId(left.candidate).localeCompare(candidateId(right.candidate));
}

function hasOnlyKnownNonEnglishLanguages(candidate) {
  const languages = candidateValues(candidate, 'languages').map(value => String(value).toLowerCase().replace('_', '-'));
  const hasEnglish = languages.some(language => language === 'en' || language === 'eng' || language === 'english' || language.startsWith('en-'));
  return languages.length > 0 && !hasEnglish;
}

function equivalentWorkKey(item) {
  if (hasOnlyKnownNonEnglishLanguages(item.candidate)) return `non_english|${candidateId(item.candidate)}`;
  const { match } = item;
  return [
    match.titleMatch.kind,
    match.titleMatch.candidate,
    match.authorMatch.candidate,
  ].join('|');
}

export function consolidateEquivalentOpenLibraryWorks(source, candidates) {
  const eligible = candidates.map(candidate => ({ candidate, match: matchWork(source, candidate) }))
    .filter(item => item.match.eligible);
  const grouped = new Map();
  for (const item of eligible) {
    const key = equivalentWorkKey(item);
    const members = grouped.get(key) ?? [];
    members.push(item);
    grouped.set(key, members);
  }
  return [...grouped.entries()].map(([groupKey, members]) => {
    const orderedMembers = [...members].sort(compareWorkRepresentatives);
    const representative = orderedMembers[0];
    const workIds = [...new Set(members.map(item => item.candidate?.providerIds?.workId).filter(Boolean))].sort();
    return {
      candidate: representative.candidate,
      match: representative.match,
      groupKey,
      members: orderedMembers,
      workIds,
    };
  });
}

function plausiblePublicationYear(value) {
  return Number.isInteger(value) && value >= 1000 && value <= new Date().getFullYear() + 1;
}

function explicitPublicationDateYear(value) {
  if (plausiblePublicationYear(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const patterns = [
    /^(\d{4})$/,
    /^(\d{4})-(?:0?[1-9]|1[0-2])(?:-(?:0?[1-9]|[12]\d|3[01]))?$/,
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2},?)?\s+(\d{4})$/i,
    /^\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const year = match ? Number(match[1]) : null;
    if (plausiblePublicationYear(year)) return year;
  }
  return null;
}

export function selectEditionPublicationYear(candidate) {
  const publicationDates = Array.isArray(candidate?.publicationDates) ? candidate.publicationDates : [];
  const explicitYears = [...new Set(publicationDates
    .map(explicitPublicationDateYear)
    .filter(plausiblePublicationYear))];
  if (explicitYears.length === 1) return explicitYears[0];
  if (publicationDates.length > 0) return null;

  const fallbackYears = [...new Set((Array.isArray(candidate?.publicationYears) ? candidate.publicationYears : [])
    .filter(plausiblePublicationYear))].sort((left, right) => left - right);
  return fallbackYears[0] ?? null;
}

function firstValue(value) {
  return values(value)[0] ?? null;
}

function workChoice(source, candidates) {
  const matches = consolidateEquivalentOpenLibraryWorks(source, candidates)
    .sort((left, right) => right.match.score - left.match.score || candidateId(left.candidate).localeCompare(candidateId(right.candidate)));
  if (!matches.length) return { status: 'no_match', matches };
  const winner = matches[0];
  const runnerUp = matches[1] ?? null;
  if (runnerUp && winner.match.score - runnerUp.match.score < WORK_MATCH_MARGIN) return { status: 'ambiguous', winner, runnerUp, matches };
  return { status: 'selected', winner, runnerUp, matches };
}

function editionIdentity(candidate) {
  const editionId = candidate?.providerIds?.editionId;
  if (editionId) return `${candidate.provider ?? 'unknown'}:edition:${editionId}`;
  const isbns = [];
  for (const value of candidateValues(candidate, 'isbn13')) {
    try { isbns.push(normalizeIsbn13(value)); } catch { /* Invalid provider identifiers cannot identify an edition. */ }
  }
  const isbn = [...new Set(isbns)].sort()[0];
  if (isbn) return `${candidate.provider ?? 'unknown'}:isbn:${isbn}`;
  return `${candidate.provider ?? 'unknown'}:candidate:${candidateId(candidate)}`;
}

function editionMetadataQuality(candidate) {
  return [
    candidateValues(candidate, 'authors').length,
    candidateValues(candidate, 'languages').length,
    candidateValues(candidate, 'publishers').length,
    candidateValues(candidate, 'formats').length,
    candidateValues(candidate, 'coverImageUrls').length,
    candidateValues(candidate, 'descriptions').length,
    candidateValues(candidate, 'publicationYears').length,
    candidateValues(candidate, 'subjects').length,
  ].reduce((total, count) => total + Number(Boolean(count)), 0);
}

export function deduplicateOpenLibraryEditions(candidates) {
  const editions = new Map();
  for (const candidate of candidates) {
    const key = editionIdentity(candidate);
    const existing = editions.get(key);
    if (!existing
      || editionMetadataQuality(candidate) > editionMetadataQuality(existing)
      || editionMetadataQuality(candidate) === editionMetadataQuality(existing) && candidateId(candidate).localeCompare(candidateId(existing)) < 0) {
      editions.set(key, candidate);
    }
  }
  return [...editions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, candidate]) => candidate);
}

function equivalentWorkNotes(choice) {
  if (choice.workIds.length < 2) return [];
  return [
    `open_library_equivalent_work_group:${choice.workIds.join(',')}`,
    `open_library_equivalent_work_key:${choice.groupKey}`,
  ];
}

function providerIds({ selected, openWork = null, exactGoogle = null }) {
  return {
    openLibraryWork: openWork?.providerIds?.workId ?? (selected?.provider === 'open_library' ? selected.providerIds?.workId ?? null : null),
    openLibraryEdition: selected?.provider === 'open_library' ? selected.providerIds?.editionId ?? null : null,
    googleBooksVolume: exactGoogle?.providerIds?.volumeId ?? (selected?.provider === 'google_books' ? selected.providerIds?.volumeId ?? null : null),
  };
}

function mergedMetadata(source, { selected, isbn, openWork, exactGoogle }) {
  const selectedOpenLibrary = selected.provider === 'open_library';
  const description = [
    [firstValue(openWork?.descriptions), 'open_library_work'],
    [firstValue(selected?.descriptions), selectedOpenLibrary ? 'open_library_edition' : 'google_books'],
    [firstValue(exactGoogle?.descriptions), 'google_books'],
  ].find(([value]) => value) ?? [null, null];
  const cover = [
    [selectedOpenLibrary ? firstValue(selected?.coverImageUrls) : null, 'open_library_edition'],
    [!selectedOpenLibrary ? firstValue(selected?.coverImageUrls) : null, 'google_books'],
    [firstValue(exactGoogle?.coverImageUrls), 'google_books'],
  ].find(([value]) => value) ?? [null, null];
  const genreInputs = [
    ...values(openWork?.subjects),
    ...values(selected?.subjects),
    ...values(exactGoogle?.subjects),
  ];
  const genres = mapGenres(genreInputs);
  const genreProvenance = genres.length
    ? openWork?.subjects?.length ? 'open_library_work' : selectedOpenLibrary ? 'open_library_edition' : 'google_books'
    : null;
  const publicationYear = selectEditionPublicationYear(selected);
  return {
    metadata: {
      title: source.title,
      author: source.author,
      isbn,
      publicationYear,
      description: description[0],
      coverImageUrl: cover[0],
      genres,
    },
    provenance: {
      title: 'curated_source',
      author: 'curated_source',
      publicationYear: publicationYear === null ? null : selectedOpenLibrary ? 'open_library_edition' : 'google_books',
      description: description[1],
      coverImageUrl: cover[1],
      genres: genreProvenance,
    },
  };
}

function resolvedEntry(source, selection, context) {
  const { metadata, provenance } = mergedMetadata(source, { selected: selection.selected, isbn: selection.isbn, openWork: context.openWork, exactGoogle: context.exactGoogle });
  const sourceName = selection.selected.provider === 'open_library' ? 'selected_open_library_edition' : 'selected_google_books_volume';
  return validateResolvedEntryForSource(source, entryBase(source, 'resolved', {
    metadata,
    providerIds: providerIds({ selected: selection.selected, openWork: context.openWork, exactGoogle: context.exactGoogle }),
    provenance,
    selection: { score: selection.score, reasons: [...selection.reasons, sourceName, ...context.notes] },
    diagnostic: null,
  }));
}

function resolvedOrPinnedReview(source, selection, context) {
  if (source.pinnedIsbn13 && selection.isbn !== source.pinnedIsbn13) {
    return reviewEntry(
      source,
      'pinned_isbn_mismatch',
      `Pinned ISBN ${source.pinnedIsbn13} was required, but edition selection chose ${selection.isbn}`,
      'edition_selection',
    );
  }
  return resolvedEntry(source, selection, context);
}

function selectionReview(source, selection) {
  const code = selection.reason === 'ambiguous_winner' ? 'ambiguous_edition_winner'
    : selection.reason === 'below_minimum_score' ? 'below_minimum_edition_score'
      : 'no_eligible_edition';
  return reviewEntry(source, code, `Edition selection requires review: ${selection.reason}`, 'edition_selection');
}

async function invoke(context, client, method, argument) {
  context.summary.providerCalls++;
  return client[method](argument);
}

function usableGoogleExact(source, candidate) {
  return candidate && matchWork(source, candidate).eligible && selectEdition(source, [candidate]).status === 'selected'
    ? candidate
    : null;
}

function openLibraryMetadataNeedsEnrichment(source, selection, openWork) {
  const { metadata } = mergedMetadata(source, {
    selected: selection.selected,
    isbn: selection.isbn,
    openWork,
    exactGoogle: null,
  });
  return !metadata.coverImageUrl || !metadata.description;
}

async function lookupGoogleExact(source, context, isbn, { notes, optional = false }) {
  try {
    const candidate = await invoke(context, context.providers.googleBooks, 'lookupByIsbn', isbn);
    return { candidate: usableGoogleExact(source, candidate), error: null };
  } catch (error) {
    notes.push(optional ? 'google_books_optional_exact_isbn_failed' : 'google_books_exact_isbn_failed');
    return { candidate: null, error };
  }
}

async function resolveGoogleFallback(source, context, { notes, errors, openChoice, fallbackReview = null, exactLookup = null }) {
  let googleVolumes = [];
  let exactGoogle = exactLookup?.candidate ?? null;

  try { googleVolumes = await invoke(context, context.providers.googleBooks, 'searchVolumes', { title: source.title, author: source.author }); }
  catch (error) { errors.push(error); notes.push('google_books_search_failed'); }

  const exactIsbn = source.pinnedIsbn13 ?? source.preferredIsbn13;
  if (exactIsbn && exactLookup === null) {
    const exact = await lookupGoogleExact(source, context, exactIsbn, { notes });
    if (exact.error) errors.push(exact.error);
    exactGoogle = exact.candidate;
  }

  const googleCandidates = [...googleVolumes, exactGoogle].filter(Boolean)
    .filter((candidate, index, list) => list.findIndex(other => candidateId(other) === candidateId(candidate)) === index)
    .filter(candidate => matchWork(source, candidate).eligible);
  if (googleCandidates.length) {
    const selection = selectEdition(source, googleCandidates);
    if (selection.status === 'selected') return resolvedOrPinnedReview(source, selection, { openWork: null, exactGoogle, notes });
    if (selection.status === 'needs_review' && !errors.length) return selectionReview(source, selection);
  }

  if (errors.length) return failedEntry(source, errors[0]);
  if (fallbackReview) return fallbackReview;
  if (openChoice.status === 'selected') return reviewEntry(source, 'no_eligible_edition', 'The matched Open Library work has no eligible edition', 'edition_selection');
  return reviewEntry(source, 'no_matched_work', 'No provider work or volume strongly matched the curated source', 'work_matching');
}

async function resolveSource(source, context) {
  const notes = [];
  const errors = [];
  let openWorks = [];
  let fallbackReview = null;

  try { openWorks = await invoke(context, context.providers.openLibrary, 'searchWorks', { title: source.title, author: source.author }); }
  catch (error) { errors.push(error); notes.push('open_library_search_failed'); }

  const openChoice = workChoice(source, openWorks);
  if (openChoice.status === 'ambiguous') {
    fallbackReview = reviewEntry(source, 'ambiguous_work_match', 'Multiple Open Library works match with insufficient separation', 'work_matching');
  }

  if (openChoice.status === 'selected') {
    let openWork = openChoice.winner.candidate;
    notes.push(...equivalentWorkNotes(openChoice.winner));
    if (typeof context.providers.openLibrary.fetchWork === 'function') {
      try { openWork = await invoke(context, context.providers.openLibrary, 'fetchWork', openWork.providerIds.workId) ?? openWork; }
      catch (error) { errors.push(error); notes.push('open_library_work_details_failed'); }
    }
    const editions = [];
    let editionFetchSucceeded = false;
    for (const workId of openChoice.winner.workIds) {
      try {
        editions.push(...await invoke(context, context.providers.openLibrary, 'fetchEditionsForWork', workId));
        editionFetchSucceeded = true;
      } catch (error) {
        errors.push(error);
        notes.push(`open_library_editions_failed:${workId}`);
      }
    }
    if (editionFetchSucceeded) {
      const selection = selectEdition(source, deduplicateOpenLibraryEditions(editions), { workMatch: openChoice.winner.match });
      if (selection.status === 'selected') {
        if (source.pinnedIsbn13 && selection.isbn !== source.pinnedIsbn13) {
          const exact = await lookupGoogleExact(source, context, source.pinnedIsbn13, { notes });
          if (exact.candidate) return resolvedOrPinnedReview(source, selectEdition(source, [exact.candidate]), { openWork: null, exactGoogle: exact.candidate, notes });
          if (exact.error) errors.push(exact.error);
          fallbackReview = resolvedOrPinnedReview(source, selection, { openWork, exactGoogle: null, notes });
          return resolveGoogleFallback(source, context, { notes, errors, openChoice, fallbackReview, exactLookup: exact });
        }

        let exactGoogle = null;
        if (openLibraryMetadataNeedsEnrichment(source, selection, openWork)) {
          const exact = await lookupGoogleExact(source, context, selection.isbn, { notes, optional: true });
          exactGoogle = exact.candidate;
        }
        return resolvedOrPinnedReview(source, selection, { openWork, exactGoogle, notes });
      }
      if (selection.status === 'needs_review') fallbackReview = selectionReview(source, selection);
      if (selection.status === 'no_match') fallbackReview = reviewEntry(source, 'no_eligible_edition', 'The matched Open Library work has no eligible edition', 'edition_selection');
    }
    if (!editionFetchSucceeded && !errors.length) fallbackReview = reviewEntry(source, 'no_eligible_edition', 'The matched Open Library work has no eligible edition', 'edition_selection');
  }

  return resolveGoogleFallback(source, context, { notes, errors, openChoice, fallbackReview });
}

function artifactFor(entries) {
  const artifact = { artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion: CATALOG_RESOLVER_VERSION, entries };
  validateResolvedArtifact(artifact);
  return artifact;
}

function readExistingArtifact(existingArtifact) {
  if (!existingArtifact) return { entries: new Map(), current: new Set() };
  const artifact = validateResolvedArtifact(existingArtifact);
  const current = artifact.resolverVersion === CATALOG_RESOLVER_VERSION
    ? artifact.entries.filter(entry => entry.resolverVersion === CATALOG_RESOLVER_VERSION).map(entry => entry.key)
    : [];
  return { entries: new Map(existingArtifact.entries.map(entry => [entry.key, entry])), current: new Set(current) };
}

function reusable(source, existing, current, options) {
  if (!existing || !current.has(source.key) || existing.sourceFingerprint !== sourceFingerprint(source) || existing.resolverVersion !== CATALOG_RESOLVER_VERSION) return false;
  if (existing.status === 'resolved') return !options.refresh;
  if (existing.status === 'needs_review') return !options.retryReview;
  if (existing.status === 'failed') return !options.retryFailed;
  return false;
}

async function runBounded(items, concurrency, worker) {
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

export async function writeArtifactAtomic(path, artifact, { fsImpl = fs, platform = process.platform } = {}) {
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${path}.${process.pid}.${randomUUID()}.bak`;
  await fsImpl.mkdir(dirname(path), { recursive: true });
  let handle;
  let backupExists = false;
  try {
    handle = await fsImpl.open(temporary, 'w', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fsImpl.rename(temporary, path);
    } catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;

      try {
        await fsImpl.rename(path, backup);
        backupExists = true;
      } catch {
        throw error;
      }

      try {
        await fsImpl.rename(temporary, path);
      } catch (replacementError) {
        try {
          await fsImpl.rename(backup, path);
          backupExists = false;
        } catch (restoreError) {
          throw new AggregateError(
            [replacementError, restoreError],
            `Artifact replacement failed; the prior artifact remains recoverable at ${backup}`,
          );
        }
        throw replacementError;
      }

      try {
        await fsImpl.unlink(backup);
        backupExists = false;
      } catch { /* The new artifact is installed; a recoverable backup is safe. */ }
    }
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the original write error. */ }
    try { await fsImpl.unlink(temporary); } catch { /* A missing temporary file is safe. */ }
    if (backupExists) {
      try {
        await fsImpl.rename(backup, path);
        backupExists = false;
      } catch { /* Preserve the recoverable backup and the original write error. */ }
    }
    throw error;
  }
}

export async function resolveCatalog({
  sources,
  existingArtifact = null,
  providers,
  retryFailed = false,
  retryReview = false,
  refresh = false,
  key = null,
  concurrency = DEFAULT_SOURCE_CONCURRENCY,
  checkpointPath = null,
  checkpoint = null,
  writeArtifact = writeArtifactAtomic,
  afterEntry = null,
} = {}) {
  const sourceEntries = validateSourceManifest(sources);
  if (!providers?.openLibrary || !providers?.googleBooks) throw new TypeError('Open Library and Google Books clients are required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > DEFAULT_SOURCE_CONCURRENCY) throw new RangeError(`concurrency must be between 1 and ${DEFAULT_SOURCE_CONCURRENCY}`);
  if (key !== null && !sourceEntries.some(source => source.key === key)) throw new Error(`Unknown source key ${key}`);

  const existing = readExistingArtifact(existingArtifact);
  const options = { retryFailed, retryReview, refresh };
  const summary = { reused: 0, resolved: 0, needsReview: 0, failed: 0, attempted: 0, providerCalls: 0 };
  const resultEntries = new Map();
  for (const [existingKey, entry] of existing.entries) {
    if (key !== null) resultEntries.set(existingKey, entry);
    else if (sourceEntries.some(source => source.key === existingKey) && existing.current.has(existingKey)) resultEntries.set(existingKey, entry);
  }

  const outputEntries = () => {
    if (key !== null) {
      return [...resultEntries.values()];
    }
    return sourceEntries.map(source => resultEntries.get(source.key)).filter(Boolean);
  };
  const buildArtifact = () => artifactFor(outputEntries());
  const checkpointWriter = checkpoint ?? (checkpointPath ? artifact => writeArtifact(checkpointPath, artifact) : null);
  let checkpointChain = Promise.resolve();
  let checkpointError = null;
  const persist = async () => {
    if (!checkpointWriter) return;
    const task = checkpointChain.then(async () => {
      if (checkpointError) throw checkpointError;
      await checkpointWriter(buildArtifact());
    });
    checkpointChain = task.catch(error => { checkpointError = error; });
    await task;
  };

  const plans = sourceEntries.filter(source => key === null || source.key === key);
  await runBounded(plans, concurrency, async source => {
    const prior = existing.entries.get(source.key);
    if (reusable(source, prior, existing.current, options)) {
      resultEntries.set(source.key, prior);
      summary.reused++;
      if (prior.status === 'needs_review') summary.needsReview++;
      if (prior.status === 'failed') summary.failed++;
      return;
    }

    summary.attempted++;
    const entry = await resolveSource(source, { providers, summary });
    resultEntries.set(source.key, entry);
    if (entry.status === 'resolved') summary.resolved++;
    if (entry.status === 'needs_review') summary.needsReview++;
    if (entry.status === 'failed') summary.failed++;
    await persist();
    if (afterEntry) await afterEntry(entry, buildArtifact());
  });

  await checkpointChain;
  return { artifact: buildArtifact(), summary };
}
