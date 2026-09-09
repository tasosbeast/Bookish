import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consolidateEquivalentOpenLibraryWorks,
  deduplicateOpenLibraryEditions,
  resolveCatalog,
} from '../scripts/catalog/resolve.js';
import { CatalogProviderError } from '../scripts/catalog/providers/errors.js';

const ISBN_A = '9780141439518';
const ISBN_B = '9780451524935';

function source(overrides = {}) {
  return { key: 'nineteen-eighty-four-george-orwell', title: '1984', author: 'George Orwell', ...overrides };
}

function work(sourceEntry, id, overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'work_search', providerIds: { workId: id, editionId: null },
    title: sourceEntry.title, subtitle: null, authors: [sourceEntry.author], authorKeys: [], languages: ['eng'], isbn13: [],
    publishers: [], formats: [], publicationDates: [], publicationYears: [], coverImageUrls: [], descriptions: [], subjects: [],
    ...overrides,
  };
}

function edition(sourceEntry, workId, editionId, isbn = ISBN_A, overrides = {}) {
  return {
    provider: 'open_library', sourceType: 'edition', providerIds: { workId, editionId },
    title: sourceEntry.title, subtitle: null, authors: [], authorKeys: [], languages: ['eng'], isbn13: [isbn],
    publishers: ['Penguin'], formats: ['Paperback'], publicationDates: ['2003'], publicationYears: [2003],
    coverImageUrls: ['https://covers.openlibrary.org/b/id/1-L.jpg?default=false'], descriptions: ['Description'], subjects: ['Fiction'],
    ...overrides,
  };
}

function providerFixture({ works, editionsByWork = {}, editionErrors = {}, detailsByWork = {} }) {
  const calls = { workDetails: [], editions: [] };
  return {
    calls,
    providers: {
      openLibrary: {
        async searchWorks() { return works; },
        async fetchWork(id) { calls.workDetails.push(id); return detailsByWork[id] ?? works.find(candidate => candidate.providerIds.workId === id) ?? null; },
        async fetchEditionsForWork(id) {
          calls.editions.push(id);
          if (editionErrors[id]) throw editionErrors[id];
          return editionsByWork[id] ?? [];
        },
      },
      googleBooks: {
        async searchVolumes() { return []; },
        async lookupByIsbn() { return null; },
      },
    },
  };
}

test('1984-style exact Open Library duplicates form one logical work and fetch every member edition set', async () => {
  const sourceEntry = source();
  const works = Array.from({ length: 5 }, (_, index) => work(sourceEntry, `OL${index + 1}W`));
  const configured = providerFixture({
    works,
    editionsByWork: { OL5W: [edition(sourceEntry, 'OL5W', 'OL5M')] },
  });

  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'resolved');
  assert.deepEqual(configured.calls.editions, ['OL1W', 'OL2W', 'OL3W', 'OL4W', 'OL5W']);
  assert.ok(entry.selection.reasons.includes('open_library_equivalent_work_group:OL1W,OL2W,OL3W,OL4W,OL5W'));
});

test('Artemis Fowl-style duplicate works are not ambiguous', async () => {
  const sourceEntry = source({ key: 'artemis-fowl-eoin-colfer', title: 'Artemis Fowl', author: 'Eoin Colfer' });
  const works = [work(sourceEntry, 'OL5725956W'), work(sourceEntry, 'OL29317061W')];
  const configured = providerFixture({ works, editionsByWork: { OL29317061W: [edition(sourceEntry, 'OL29317061W', 'OL1M')] } });

  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });

  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.deepEqual(configured.calls.editions, ['OL29317061W', 'OL5725956W']);
});

test('representative choice is deterministic while editions from non-representative works remain selectable', async () => {
  const sourceEntry = source();
  const sparse = work(sourceEntry, 'OL2W');
  const richer = work(sourceEntry, 'OL1W', { providerIds: { workId: 'OL1W', editionId: 'OLSEARCHM' }, isbn13: [ISBN_B], subjects: ['Dystopian fiction'] });
  const forward = consolidateEquivalentOpenLibraryWorks(sourceEntry, [sparse, richer]);
  const reverse = consolidateEquivalentOpenLibraryWorks(sourceEntry, [richer, sparse]);
  assert.equal(forward[0].candidate.providerIds.workId, 'OL1W');
  assert.equal(reverse[0].candidate.providerIds.workId, 'OL1W');

  const configured = providerFixture({ works: [sparse, richer], editionsByWork: { OL2W: [edition(sourceEntry, 'OL2W', 'OL2M')] } });
  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });
  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.equal(result.artifact.entries[0].providerIds.openLibraryEdition, 'OL2M');
  assert.deepEqual(configured.calls.workDetails, ['OL1W']);
});

test('duplicate editions returned by equivalent works are deduplicated before selection', async () => {
  const sourceEntry = source();
  const duplicateA = edition(sourceEntry, 'OL1W', 'OLSHAREDM');
  const duplicateB = edition(sourceEntry, 'OL2W', 'OLSHAREDM', ISBN_A, { descriptions: [] });
  assert.equal(deduplicateOpenLibraryEditions([duplicateB, duplicateA]).length, 1);

  const configured = providerFixture({
    works: [work(sourceEntry, 'OL1W'), work(sourceEntry, 'OL2W')],
    editionsByWork: { OL1W: [duplicateA], OL2W: [duplicateB] },
  });
  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });
  assert.equal(result.artifact.entries[0].status, 'resolved');
  assert.equal(result.artifact.entries[0].providerIds.openLibraryEdition, 'OLSHAREDM');
});

test('distinct titles stay separate and retain work ambiguity', async () => {
  const sourceEntry = source({ key: 'alpha-beta-gamma-delta-author-name', title: 'Alpha Beta Gamma Delta', author: 'Author Name' });
  const works = [
    work(sourceEntry, 'OL1W'),
    work(sourceEntry, 'OL2W', { title: 'Gamma Beta Alpha Delta' }),
  ];
  const configured = providerFixture({ works });

  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });

  assert.equal(result.artifact.entries[0].diagnostic.code, 'ambiguous_work_match');
  assert.deepEqual(configured.calls.editions, []);
});

test('different authors, translations, collections, graphic adaptations and sequels never join the original group', () => {
  const sourceEntry = source({ key: 'the-hobbit-j-r-r-tolkien', title: 'The Hobbit', author: 'J. R. R. Tolkien' });
  const original = work(sourceEntry, 'OL1W');
  const candidates = [
    original,
    work(sourceEntry, 'OL2W', { authors: ['Different Author'] }),
    work(sourceEntry, 'OL3W', { languages: ['spa'] }),
    work(sourceEntry, 'OL4W', { title: 'The Hobbit Omnibus' }),
    work(sourceEntry, 'OL5W', { title: 'The Hobbit Graphic Novel' }),
    work(sourceEntry, 'OL6W', { title: 'The Hobbit The Desolation of Smaug' }),
  ];

  const groups = consolidateEquivalentOpenLibraryWorks(sourceEntry, candidates);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].workIds, ['OL1W']);
  assert.deepEqual(groups[1].workIds, ['OL3W']);
});

test('equivalent work consolidation cannot bypass a pinned ISBN mismatch', async () => {
  const sourceEntry = source({ preferredIsbn13: ISBN_B, pinnedIsbn13: ISBN_B });
  const configured = providerFixture({
    works: [work(sourceEntry, 'OL1W'), work(sourceEntry, 'OL2W')],
    editionsByWork: { OL2W: [edition(sourceEntry, 'OL2W', 'OL2M', ISBN_A)] },
  });

  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });

  assert.equal(result.artifact.entries[0].status, 'needs_review');
  assert.equal(result.artifact.entries[0].diagnostic.code, 'pinned_isbn_mismatch');
});

test('one equivalent work edition failure does not discard another work successful edition', async () => {
  const sourceEntry = source();
  const timeout = new CatalogProviderError({ provider: 'open_library', stage: 'editions', code: 'timeout', status: null, retryable: true, attempts: 3, message: 'Timed out' });
  const configured = providerFixture({
    works: [work(sourceEntry, 'OL1W'), work(sourceEntry, 'OL2W')],
    editionErrors: { OL1W: timeout },
    editionsByWork: { OL2W: [edition(sourceEntry, 'OL2W', 'OL2M')] },
  });

  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });
  const entry = result.artifact.entries[0];

  assert.equal(entry.status, 'resolved');
  assert.ok(entry.selection.reasons.includes('open_library_editions_failed:OL1W'));
});

test('all equivalent work edition failures preserve failed provider diagnostics', async () => {
  const sourceEntry = source();
  const timeout = new CatalogProviderError({ provider: 'open_library', stage: 'editions', code: 'timeout', status: null, retryable: true, attempts: 3, message: 'Timed out' });
  const configured = providerFixture({
    works: [work(sourceEntry, 'OL1W'), work(sourceEntry, 'OL2W')],
    editionErrors: { OL1W: timeout, OL2W: timeout },
  });

  const result = await resolveCatalog({ sources: [sourceEntry], providers: configured.providers });

  assert.equal(result.artifact.entries[0].status, 'failed');
  assert.equal(result.artifact.entries[0].diagnostic.code, 'timeout');
  assert.equal(result.artifact.entries[0].diagnostic.stage, 'editions');
});
