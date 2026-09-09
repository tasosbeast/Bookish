import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATALOG_ARTIFACT_VERSION,
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  sourceFingerprint,
  validateResolvedArtifact,
} from '../scripts/catalog/contracts.js';
import { resolveCatalog, writeArtifactAtomic } from '../scripts/catalog/resolve.js';
import { CatalogProviderError } from '../scripts/catalog/providers/errors.js';

const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';
const baseSource = { key: 'pride-and-prejudice-jane-austen', title: 'Pride and Prejudice', author: 'Jane Austen' };

function work(source, id = 'OL1W', overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'work', providerIds: { workId: id, editionId: null }, title: source.title,
    subtitle: null, authors: [source.author], languages: ['eng'], isbn13: [], publishers: [], formats: [], publicationDates: [],
    publicationYears: [], coverImageUrls: [], descriptions: ['Open Library work description.'], subjects: ['Science Fiction'], ...overrides,
  };
}

function edition(source, isbn = ISBN_A, id = 'OL1M', overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'edition', providerIds: { workId: 'OL1W', editionId: id }, title: source.title,
    subtitle: null, authors: [], languages: ['eng'], isbn13: [isbn], publishers: ['Penguin'], formats: ['Paperback'], publicationDates: ['2003'],
    publicationYears: [2003], coverImageUrls: ['https://covers.openlibrary.org/b/id/1-L.jpg?default=false'], descriptions: ['Edition description.'], subjects: ['Fiction'], ...overrides,
  };
}

function googleVolume(source, isbn = ISBN_A, id = 'google-1', overrides = {}) {
  return {
    provider: 'google_books', sourceType: 'volume', providerIds: { volumeId: id }, title: source.title,
    subtitle: null, authors: [source.author], languages: ['en'], isbn13: [isbn], publishers: ['Google Books'], formats: ['BOOK'], publicationDates: ['2003'],
    publicationYears: [2003], coverImageUrls: ['https://books.google.com/books/content?id=1'], descriptions: ['Google Books description.'], subjects: ['Fantasy'], ...overrides,
  };
}

function resolvedEntry(source, isbn = ISBN_A) {
  return {
    key: source.key,
    sourceFingerprint: sourceFingerprint(source),
    resolverVersion: CATALOG_RESOLVER_VERSION,
    status: 'resolved',
    metadata: { title: source.title, author: source.author, isbn, publicationYear: 2003, description: null, coverImageUrl: null, genres: [{ name: 'Fiction', slug: 'fiction' }] },
    providerIds: { openLibraryWork: null, openLibraryEdition: null, googleBooksVolume: null },
    provenance: { title: 'curated_source', author: 'curated_source', publicationYear: null, description: null, coverImageUrl: null, genres: null },
    selection: { score: 60, reasons: ['fixture'] },
    diagnostic: null,
  };
}

function reviewEntry(source) {
  return {
    key: source.key, sourceFingerprint: sourceFingerprint(source), resolverVersion: CATALOG_RESOLVER_VERSION, status: 'needs_review',
    diagnostic: { provider: null, stage: 'edition_selection', code: 'ambiguous_edition_winner', message: 'Review required', retryable: false, attempts: 0 },
  };
}

function failedEntry(source) {
  return {
    key: source.key, sourceFingerprint: sourceFingerprint(source), resolverVersion: CATALOG_RESOLVER_VERSION, status: 'failed',
    diagnostic: { provider: 'open_library', stage: 'search', code: 'timeout', message: 'Timed out', retryable: true, attempts: 3 },
  };
}

function artifact(entries) {
  return { artifactVersion: CATALOG_ARTIFACT_VERSION, resolverVersion: CATALOG_RESOLVER_VERSION, entries };
}

function providers({ openWorks = [work(baseSource)], openEditions = [edition(baseSource)], googleVolumes = [], exactGoogle = null, errors = {} } = {}) {
  const calls = { openSearch: 0, openWork: 0, openEditions: 0, googleSearch: 0, googleExact: 0 };
  const result = value => typeof value === 'function' ? value() : value;
  const clients = {
    openLibrary: {
      async searchWorks() { calls.openSearch++; if (errors.openSearch) throw errors.openSearch; return result(openWorks); },
      async fetchWork() { calls.openWork++; if (errors.openWork) throw errors.openWork; return result(openWorks[0] ?? null); },
      async fetchEditionsForWork() { calls.openEditions++; if (errors.openEditions) throw errors.openEditions; return result(openEditions); },
    },
    googleBooks: {
      async searchVolumes() { calls.googleSearch++; if (errors.googleSearch) throw errors.googleSearch; return result(googleVolumes); },
      async lookupByIsbn() { calls.googleExact++; if (errors.googleExact) throw errors.googleExact; return result(exactGoogle); },
    },
  };
  return { clients, calls };
}

function sourceAt(index) {
  return { key: `book-${index}-author-${index}`, title: `Book ${index}`, author: `Author ${index}` };
}

function isbnAt(index) {
  const stem = `978${String(index).padStart(9, '0')}`;
  const sum = [...stem].reduce((total, digit, position) => total + Number(digit) * (position % 2 ? 3 : 1), 0);
  return `${stem}${(10 - sum % 10) % 10}`;
}

function sourceAwareProviders(sources, { fixedIsbn = null, onSearch = null } = {}) {
  const byTitle = new Map(sources.map((source, index) => [source.title, { source, index, work: work(source, `OL${index + 1}W`), edition: edition(source, fixedIsbn ?? isbnAt(index), `OL${index + 1}M`) }]));
  const calls = { openSearch: 0, openSearchTitles: [], openWork: 0, openEditions: 0, googleSearch: 0, googleExact: 0 };
  return {
    calls,
    clients: {
      openLibrary: {
        async searchWorks(input) { calls.openSearch++; calls.openSearchTitles.push(input.title); await onSearch?.(); return [byTitle.get(input.title).work]; },
        async fetchWork(id) { calls.openWork++; return [...byTitle.values()].find(item => item.work.providerIds.workId === id)?.work ?? null; },
        async fetchEditionsForWork(id) { calls.openEditions++; return [[...byTitle.values()].find(item => item.work.providerIds.workId === id)?.edition].filter(Boolean); },
      },
      googleBooks: {
        async searchVolumes() { calls.googleSearch++; return []; },
        async lookupByIsbn() { calls.googleExact++; return null; },
      },
    },
  };
}

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bookish-catalog-v2-'));
  try { await run(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('resolver creates a valid resolved artifact from a clear Open Library work and edition', async () => {
  const { clients, calls } = providers();
  const result = await resolveCatalog({ sources: [baseSource], providers: clients });
  assert.equal(result.summary.resolved, 1);
  assert.equal(result.summary.providerCalls, 3);
  assert.deepEqual(validateResolvedArtifact(result.artifact), result.artifact);
  const entry = result.artifact.entries[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.metadata.title, baseSource.title);
  assert.equal(entry.metadata.author, baseSource.author);
  assert.equal(entry.metadata.description, 'Open Library work description.');
  assert.equal(entry.metadata.coverImageUrl, 'https://covers.openlibrary.org/b/id/1-L.jpg?default=false');
  assert.deepEqual(entry.metadata.genres, [{ name: 'Science Fiction', slug: 'science-fiction' }, { name: 'Fiction', slug: 'fiction' }]);
  assert.equal(entry.metadata.averageRating, undefined);
  assert.equal(entry.provenance.description, 'open_library_work');
  assert.deepEqual(calls, { openSearch: 1, openWork: 1, openEditions: 1, googleSearch: 0, googleExact: 0 });
});

test('resolver uses Google Books when Open Library has no matching work', async () => {
  const { clients } = providers({ openWorks: [], openEditions: [], googleVolumes: [googleVolume(baseSource)] });
  const result = await resolveCatalog({ sources: [baseSource], providers: clients });
  const entry = result.artifact.entries[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.providerIds.googleBooksVolume, 'google-1');
  assert.equal(entry.provenance.coverImageUrl, 'google_books');
});

test('preferred ISBN exact lookup remains subject to Task 3 eligibility', async () => {
  const source = { ...baseSource, preferredIsbn13: ISBN_B };
  const wrongExact = googleVolume(source, ISBN_B, 'wrong', { title: 'Sense and Sensibility', authors: ['Jane Austen'] });
  const { clients } = providers({ openWorks: [], openEditions: [], googleVolumes: [], exactGoogle: wrongExact });
  const result = await resolveCatalog({ sources: [source], providers: clients });
  assert.equal(result.artifact.entries[0].status, 'needs_review');
  assert.equal(result.artifact.entries[0].diagnostic.code, 'no_matched_work');
});

test('normal preferred ISBN remains guidance and may resolve to another eligible edition', async () => {
  const source = { ...baseSource, preferredIsbn13: ISBN_B };
  const { clients } = providers({ openWorks: [work(source)], openEditions: [edition(source, ISBN_A)], exactGoogle: null });
  const result = await resolveCatalog({ sources: [source], providers: clients });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'resolved');
  assert.equal(entry.metadata.isbn, ISBN_A);
});

test('matching production pin resolves and a different selected ISBN requires review', async () => {
  const matchingSource = { ...baseSource, preferredIsbn13: ISBN_A, pinnedIsbn13: ISBN_A };
  let configured = providers({ openWorks: [work(matchingSource)], openEditions: [edition(matchingSource, ISBN_A)] });
  let result = await resolveCatalog({ sources: [matchingSource], providers: configured.clients });
  let entry = result.artifact.entries[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.metadata.isbn, matchingSource.pinnedIsbn13);

  const mismatchedSource = { ...baseSource, preferredIsbn13: ISBN_B, pinnedIsbn13: ISBN_B };
  configured = providers({ openWorks: [work(mismatchedSource)], openEditions: [edition(mismatchedSource, ISBN_A)], exactGoogle: null });
  result = await resolveCatalog({ sources: [mismatchedSource], providers: configured.clients });
  entry = result.artifact.entries[0];
  assert.equal(entry.status, 'needs_review');
  assert.equal(entry.diagnostic.code, 'pinned_isbn_mismatch');
  assert.match(entry.diagnostic.message, new RegExp(`${ISBN_B}.*${ISBN_A}`));
});

test('validated exact-ISBN Google evidence can satisfy a production pin', async () => {
  const source = { ...baseSource, preferredIsbn13: ISBN_B, pinnedIsbn13: ISBN_B };
  const exactGoogle = googleVolume(source, ISBN_B, 'pinned-google');
  const configured = providers({
    openWorks: [work(source)],
    openEditions: [edition(source, ISBN_A)],
    googleVolumes: [],
    exactGoogle,
  });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'resolved');
  assert.equal(entry.metadata.isbn, ISBN_B);
  assert.equal(entry.providerIds.googleBooksVolume, 'pinned-google');
});

test('preferred exact-ISBN evidence cannot bypass matching or pinned identity', async () => {
  const source = { ...baseSource, preferredIsbn13: ISBN_B, pinnedIsbn13: ISBN_B };
  const wrongExact = googleVolume(source, ISBN_B, 'wrong', { title: 'The Silmarillion', authors: ['J. R. R. Tolkien'] });
  const configured = providers({
    openWorks: [work(source)],
    openEditions: [edition(source, ISBN_A)],
    exactGoogle: wrongExact,
  });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'needs_review');
  assert.equal(entry.diagnostic.code, 'pinned_isbn_mismatch');
  assert.match(entry.diagnostic.message, new RegExp(`${ISBN_B}.*${ISBN_A}`));
});

test('wrong or missing pinned edition evidence never resolves automatically', async () => {
  const { preferredIsbn13, ...withoutPreference } = baseSource;
  const source = { ...withoutPreference, pinnedIsbn13: ISBN_B };
  const wrongExact = googleVolume(source, ISBN_B, 'wrong', { title: 'Sense and Sensibility', authors: ['Different Author'] });
  let configured = providers({ openWorks: [], openEditions: [], googleVolumes: [], exactGoogle: wrongExact });
  let result = await resolveCatalog({ sources: [source], providers: configured.clients });
  assert.equal(result.artifact.entries[0].status, 'needs_review');
  assert.equal(result.artifact.entries[0].diagnostic.code, 'no_matched_work');
  assert.equal(configured.calls.googleExact, 1);

  configured = providers({ openWorks: [], openEditions: [], googleVolumes: [], exactGoogle: null });
  result = await resolveCatalog({ sources: [source], providers: configured.clients });
  assert.equal(result.artifact.entries[0].status, 'needs_review');
  assert.equal(result.artifact.entries[0].diagnostic.code, 'no_matched_work');
  assert.equal(configured.calls.googleExact, 1);
});

test('provider failure retains failed semantics when it prevents pinned resolution', async () => {
  const source = { ...baseSource, preferredIsbn13: ISBN_B, pinnedIsbn13: ISBN_B };
  const timeout = new CatalogProviderError({
    provider: 'google_books', stage: 'isbn_lookup', code: 'timeout', status: null,
    retryable: true, attempts: 3, message: 'Pinned ISBN lookup timed out',
  });
  const configured = providers({
    openWorks: [work(source)],
    openEditions: [edition(source, ISBN_A)],
    errors: { googleExact: timeout },
  });
  const result = await resolveCatalog({ sources: [source], providers: configured.clients });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'failed');
  assert.equal(entry.diagnostic.code, 'timeout');
  assert.equal(entry.diagnostic.provider, 'google_books');
});

test('resolver returns needs_review for ambiguous works, editions and absent eligible editions', async () => {
  const ambiguousSource = { key: 'alpha-beta-gamma-delta-author-name', title: 'Alpha Beta Gamma Delta', author: 'Author Name' };
  const ambiguousWorks = providers({
    openWorks: [work(ambiguousSource, 'OL1W'), work(ambiguousSource, 'OL2W', { title: 'Gamma Beta Alpha Delta' })],
    googleVolumes: [],
  });
  let result = await resolveCatalog({ sources: [ambiguousSource], providers: ambiguousWorks.clients });
  assert.equal(result.artifact.entries[0].diagnostic.code, 'ambiguous_work_match');

  const ambiguousEditions = providers({ openEditions: [edition(baseSource, ISBN_A, 'OL1M'), edition(baseSource, ISBN_B, 'OL2M', { coverImageUrls: [] })] });
  result = await resolveCatalog({ sources: [baseSource], providers: ambiguousEditions.clients });
  assert.equal(result.artifact.entries[0].diagnostic.code, 'ambiguous_edition_winner');

  const noEditions = providers({ openEditions: [edition(baseSource, ISBN_A, 'OL1M', { formats: ['Audiobook'] })] });
  result = await resolveCatalog({ sources: [baseSource], providers: noEditions.clients });
  assert.equal(result.artifact.entries[0].diagnostic.code, 'no_eligible_edition');
});

test('provider failures produce failed diagnostics rather than no-match outcomes', async () => {
  const timeout = new CatalogProviderError({ provider: 'open_library', stage: 'search', code: 'timeout', status: null, retryable: true, attempts: 3, message: 'Open Library request timed out' });
  const retryable = providers({ openWorks: [], googleVolumes: [], errors: { openSearch: timeout } });
  let result = await resolveCatalog({ sources: [baseSource], providers: retryable.clients });
  assert.equal(result.artifact.entries[0].status, 'failed');
  assert.deepEqual(result.artifact.entries[0].diagnostic, { provider: 'open_library', stage: 'search', code: 'timeout', message: 'Open Library request timed out', retryable: true, attempts: 3 });

  const malformed = new CatalogProviderError({ provider: 'google_books', stage: 'search', code: 'malformed_response', status: null, retryable: false, attempts: 1, message: 'Google Books returned malformed JSON' });
  const nonRetryable = providers({ openWorks: [], googleVolumes: [], errors: { googleSearch: malformed } });
  result = await resolveCatalog({ sources: [baseSource], providers: nonRetryable.clients });
  assert.equal(result.artifact.entries[0].status, 'failed');
  assert.equal(result.artifact.entries[0].diagnostic.code, 'malformed_response');
});

test('incremental reuse skips unchanged resolved entries without provider calls', async () => {
  const existingArtifact = artifact([resolvedEntry(baseSource)]);
  const { clients, calls } = providers({ errors: { openSearch: new Error('must not be called'), googleSearch: new Error('must not be called') } });
  const result = await resolveCatalog({ sources: [baseSource], existingArtifact, providers: clients });
  assert.equal(result.summary.reused, 1);
  assert.equal(result.summary.attempted, 0);
  assert.equal(result.summary.providerCalls, 0);
  assert.deepEqual(calls, { openSearch: 0, openWork: 0, openEditions: 0, googleSearch: 0, googleExact: 0 });
});

test('changed fingerprints, stale resolver versions and refresh re-resolve entries', async () => {
  const changed = { ...baseSource, title: 'Pride & Prejudice' };
  const changedProviders = providers({ openWorks: [work(changed)], openEditions: [edition(changed)] });
  let result = await resolveCatalog({ sources: [changed], existingArtifact: artifact([resolvedEntry(baseSource)]), providers: changedProviders.clients });
  assert.equal(result.summary.attempted, 1);
  assert.equal(changedProviders.calls.openSearch, 1);

  const stale = artifact([resolvedEntry(baseSource)]);
  stale.resolverVersion = CATALOG_RESOLVER_VERSION - 1;
  stale.entries[0].resolverVersion = CATALOG_RESOLVER_VERSION - 1;
  const staleProviders = providers();
  result = await resolveCatalog({ sources: [baseSource], existingArtifact: stale, providers: staleProviders.clients });
  assert.equal(result.summary.attempted, 1);
  assert.equal(staleProviders.calls.openSearch, 1);

  const refreshProviders = providers();
  result = await resolveCatalog({ sources: [baseSource], existingArtifact: artifact([resolvedEntry(baseSource)]), providers: refreshProviders.clients, refresh: true });
  assert.equal(result.summary.attempted, 1);
  assert.equal(refreshProviders.calls.openSearch, 1);
});

test('failed and review entries retry only when their explicit options are enabled', async () => {
  const failed = providers();
  let result = await resolveCatalog({ sources: [baseSource], existingArtifact: artifact([failedEntry(baseSource)]), providers: failed.clients });
  assert.equal(result.summary.attempted, 0);
  assert.equal(failed.calls.openSearch, 0);
  const retriedFailed = providers();
  result = await resolveCatalog({ sources: [baseSource], existingArtifact: artifact([failedEntry(baseSource)]), providers: retriedFailed.clients, retryFailed: true });
  assert.equal(result.summary.attempted, 1);
  assert.equal(retriedFailed.calls.openSearch, 1);

  const review = providers();
  result = await resolveCatalog({ sources: [baseSource], existingArtifact: artifact([reviewEntry(baseSource)]), providers: review.clients });
  assert.equal(result.summary.attempted, 0);
  const retriedReview = providers();
  result = await resolveCatalog({ sources: [baseSource], existingArtifact: artifact([reviewEntry(baseSource)]), providers: retriedReview.clients, retryReview: true });
  assert.equal(result.summary.attempted, 1);
  assert.equal(retriedReview.calls.openSearch, 1);
});

test('key filters preserve unrelated current artifact entries exactly', async () => {
  const second = sourceAt(2);
  const third = sourceAt(3);
  const existingArtifact = artifact([resolvedEntry(baseSource), resolvedEntry(second, isbnAt(2)), resolvedEntry(third, isbnAt(3))]);
  const { clients, calls } = providers();
  const result = await resolveCatalog({ sources: [baseSource, second, third], existingArtifact, providers: clients, key: baseSource.key, refresh: true });
  assert.equal(result.summary.attempted, 1);
  assert.equal(calls.openSearch, 1);
  assert.equal(result.artifact.entries.length, 3);
  assert.deepEqual(result.artifact.entries.find(entry => entry.key === second.key), existingArtifact.entries[1]);
  assert.deepEqual(result.artifact.entries.find(entry => entry.key === third.key), existingArtifact.entries[2]);
});

test('key filters preserve stale unrelated entries without making them reusable', async () => {
  const second = sourceAt(2);
  const third = sourceAt(3);
  const existingArtifact = artifact([resolvedEntry(baseSource), resolvedEntry(second, isbnAt(2)), resolvedEntry(third, isbnAt(3))]);
  existingArtifact.resolverVersion = CATALOG_RESOLVER_VERSION - 1;
  for (const entry of existingArtifact.entries) entry.resolverVersion = CATALOG_RESOLVER_VERSION - 1;
  existingArtifact.entries[0].metadata.title = ` ${existingArtifact.entries[0].metadata.title} `;
  const { clients, calls } = sourceAwareProviders([baseSource, second, third]);
  const result = await resolveCatalog({ sources: [baseSource, second, third], existingArtifact, providers: clients, key: second.key });
  assert.equal(result.summary.attempted, 1);
  assert.equal(calls.openSearch, 1);
  assert.deepEqual(calls.openSearchTitles, [second.title]);
  assert.deepEqual(result.artifact.entries.map(entry => entry.key), [baseSource.key, second.key, third.key]);
  assert.deepEqual(result.artifact.entries.find(entry => entry.key === baseSource.key), existingArtifact.entries[0]);
  assert.equal(result.artifact.entries.find(entry => entry.key === second.key).resolverVersion, CATALOG_RESOLVER_VERSION);
  assert.equal(result.artifact.entries.find(entry => entry.key === third.key).resolverVersion, CATALOG_RESOLVER_VERSION - 1);
  assert.doesNotThrow(() => validateResolvedArtifact(result.artifact));
});

test('failed key-filter checkpoint writes leave the original artifact intact', async () => {
  await withTemporaryDirectory(async directory => {
    const second = sourceAt(2);
    const existingArtifact = artifact([resolvedEntry(baseSource), resolvedEntry(second, isbnAt(2))]);
    const path = join(directory, 'catalog-resolved.json');
    await fs.writeFile(path, `${JSON.stringify(existingArtifact)}\n`, 'utf8');
    const { clients } = sourceAwareProviders([baseSource, second]);
    await assert.rejects(
      resolveCatalog({
        sources: [baseSource, second],
        existingArtifact,
        providers: clients,
        key: second.key,
        refresh: true,
        checkpointPath: path,
        writeArtifact: async () => { throw new Error('simulated checkpoint failure'); },
      }),
      /simulated checkpoint failure/,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), existingArtifact);
  });
});

test('checkpoints persist each completed entry and resume after an interruption', async () => {
  await withTemporaryDirectory(async directory => {
    const sources = [sourceAt(10), sourceAt(11)];
    const first = sourceAwareProviders(sources);
    const path = join(directory, 'catalog-resolved.json');
    const checkpointSizes = [];
    await assert.rejects(
      resolveCatalog({
        sources,
        providers: first.clients,
        concurrency: 1,
        checkpointPath: path,
        afterEntry: async entry => {
          checkpointSizes.push(validateResolvedArtifact(JSON.parse(await fs.readFile(path, 'utf8'))).entries.length);
          if (entry.key === sources[0].key) throw new Error('simulated interruption');
        },
      }),
      /simulated interruption/,
    );
    const checkpoint = JSON.parse(await fs.readFile(path, 'utf8'));
    assert.equal(checkpoint.entries.length, 1);
    validateResolvedArtifact(checkpoint);

    const second = sourceAwareProviders(sources);
    const resumed = await resolveCatalog({
      sources,
      existingArtifact: checkpoint,
      providers: second.clients,
      concurrency: 1,
      checkpointPath: path,
      afterEntry: async () => checkpointSizes.push(validateResolvedArtifact(JSON.parse(await fs.readFile(path, 'utf8'))).entries.length),
    });
    assert.equal(resumed.summary.reused, 1);
    assert.equal(resumed.summary.attempted, 1);
    assert.equal(second.calls.openSearch, 1);
    assert.deepEqual(checkpointSizes, [1, 2]);
    assert.equal(validateResolvedArtifact(JSON.parse(await fs.readFile(path, 'utf8'))).entries.length, 2);
  });
});

test('atomic checkpoint writes preserve the prior valid artifact when replacement fails', async () => {
  await withTemporaryDirectory(async directory => {
    const path = join(directory, 'catalog-resolved.json');
    const before = artifact([resolvedEntry(baseSource)]);
    await fs.writeFile(path, `${JSON.stringify(before)}\n`, 'utf8');
    const after = artifact([resolvedEntry(baseSource)]);
    after.entries[0].selection.score = 61;
    const failingFs = { ...fs, rename: async () => { throw new Error('simulated rename failure'); } };
    await assert.rejects(writeArtifactAtomic(path, after, { fsImpl: failingFs }), /simulated rename failure/);
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), before);
  });
});

test('bounded concurrent resolution produces a valid uncorrupted checkpoint', async () => {
  await withTemporaryDirectory(async directory => {
    const sources = [sourceAt(20), sourceAt(21), sourceAt(22), sourceAt(23)];
    let active = 0;
    let maximum = 0;
    const { clients } = sourceAwareProviders(sources, {
      onSearch: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
      },
    });
    const path = join(directory, 'catalog-resolved.json');
    const result = await resolveCatalog({ sources, providers: clients, concurrency: 2, checkpointPath: path });
    assert.equal(maximum, 2);
    assert.equal(result.artifact.entries.length, 4);
    assert.equal(validateResolvedArtifact(JSON.parse(await fs.readFile(path, 'utf8'))).entries.length, 4);
  });
});

test('duplicate resolved ISBNs surface contract failures before an artifact is written', async () => {
  const sources = [sourceAt(30), sourceAt(31)];
  const { clients } = sourceAwareProviders(sources, { fixedIsbn: ISBN_A });
  await assert.rejects(
    resolveCatalog({ sources, providers: clients, concurrency: 1 }),
    error => error instanceof CatalogContractError && error.code === 'duplicate_resolved_isbn',
  );
});

test('a second run over 100 unchanged resolved entries makes zero provider calls', async () => {
  const sources = Array.from({ length: 100 }, (_, index) => sourceAt(index + 100));
  const existingArtifact = artifact(sources.map((source, index) => resolvedEntry(source, isbnAt(index + 100))));
  const { clients, calls } = providers({ errors: { openSearch: new Error('must not be called'), googleSearch: new Error('must not be called') } });
  const result = await resolveCatalog({ sources, existingArtifact, providers: clients });
  assert.equal(result.summary.reused, 100);
  assert.equal(result.summary.providerCalls, 0);
  assert.equal(result.summary.attempted, 0);
  assert.equal(calls.openSearch + calls.googleSearch + calls.openWork + calls.openEditions + calls.googleExact, 0);
  assert.equal(validateResolvedArtifact(result.artifact).entries.length, 100);
});
