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

function candidateYear(candidate) {
  return (Array.isArray(candidate?.publicationYears) ? candidate.publicationYears : [])
    .find(year => Number.isInteger(year) && year >= 1000 && year <= new Date().getFullYear() + 1) ?? null;
}

function firstValue(value) {
  return values(value)[0] ?? null;
}

function workChoice(source, candidates) {
  const matches = candidates.map(candidate => ({ candidate, match: matchWork(source, candidate) }))
    .filter(item => item.match.eligible)
    .sort((left, right) => right.match.score - left.match.score || candidateId(left.candidate).localeCompare(candidateId(right.candidate)));
  if (!matches.length) return { status: 'no_match', matches };
  const winner = matches[0];
  const runnerUp = matches[1] ?? null;
  if (runnerUp && winner.match.score - runnerUp.match.score < WORK_MATCH_MARGIN) return { status: 'ambiguous', winner, runnerUp, matches };
  return { status: 'selected', winner, runnerUp, matches };
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
  const publicationYear = candidateYear(selected);
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

async function resolveSource(source, context) {
  const notes = [];
  const errors = [];
  let pinnedMismatchReview = null;
  let openWorks = [];
  let googleVolumes = [];
  let exactGoogle = null;

  try { openWorks = await invoke(context, context.providers.openLibrary, 'searchWorks', { title: source.title, author: source.author }); }
  catch (error) { errors.push(error); notes.push('open_library_search_failed'); }
  try { googleVolumes = await invoke(context, context.providers.googleBooks, 'searchVolumes', { title: source.title, author: source.author }); }
  catch (error) { errors.push(error); notes.push('google_books_search_failed'); }
  const exactIsbn = source.pinnedIsbn13 ?? source.preferredIsbn13;
  if (exactIsbn) {
    try { exactGoogle = await invoke(context, context.providers.googleBooks, 'lookupByIsbn', exactIsbn); }
    catch (error) { errors.push(error); notes.push('google_books_exact_isbn_failed'); }
  }

  const openChoice = workChoice(source, openWorks);
  if (openChoice.status === 'ambiguous') {
    return reviewEntry(source, 'ambiguous_work_match', 'Multiple Open Library works match with insufficient separation', 'work_matching');
  }

  const usableExactGoogle = exactGoogle && matchWork(source, exactGoogle).eligible && selectEdition(source, [exactGoogle]).status === 'selected'
    ? exactGoogle
    : null;
  const googleCandidates = [...googleVolumes, usableExactGoogle].filter(Boolean)
    .filter((candidate, index, list) => list.findIndex(other => candidateId(other) === candidateId(candidate)) === index)
    .filter(candidate => matchWork(source, candidate).eligible);

  if (openChoice.status === 'selected') {
    let openWork = openChoice.winner.candidate;
    if (typeof context.providers.openLibrary.fetchWork === 'function') {
      try { openWork = await invoke(context, context.providers.openLibrary, 'fetchWork', openWork.providerIds.workId) ?? openWork; }
      catch (error) { errors.push(error); notes.push('open_library_work_details_failed'); }
    }
    try {
      const editions = await invoke(context, context.providers.openLibrary, 'fetchEditionsForWork', openChoice.winner.candidate.providerIds.workId);
      const selection = selectEdition(source, editions, { workMatch: openChoice.winner.match });
      if (selection.status === 'selected') {
        const finalized = resolvedOrPinnedReview(source, selection, { openWork, exactGoogle: usableExactGoogle, notes });
        if (finalized.status === 'resolved') return finalized;
        pinnedMismatchReview = finalized;
      }
      if (selection.status === 'needs_review' && !errors.length) return selectionReview(source, selection);
    } catch (error) {
      errors.push(error);
      notes.push('open_library_editions_failed');
    }
  }

  if (googleCandidates.length) {
    const selection = selectEdition(source, googleCandidates);
    if (selection.status === 'selected') return resolvedOrPinnedReview(source, selection, { openWork: null, exactGoogle: usableExactGoogle, notes });
    if (selection.status === 'needs_review' && !errors.length) return selectionReview(source, selection);
  }

  if (errors.length) return failedEntry(source, errors[0]);
  if (pinnedMismatchReview) return pinnedMismatchReview;
  if (openChoice.status === 'selected') return reviewEntry(source, 'no_eligible_edition', 'The matched Open Library work has no eligible edition', 'edition_selection');
  return reviewEntry(source, 'no_matched_work', 'No provider work or volume strongly matched the curated source', 'work_matching');
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

export async function writeArtifactAtomic(path, artifact, { fsImpl = fs } = {}) {
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await fsImpl.mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await fsImpl.open(temporary, 'w', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, path);
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the original write error. */ }
    try { await fsImpl.unlink(temporary); } catch { /* A missing temporary file is safe. */ }
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
