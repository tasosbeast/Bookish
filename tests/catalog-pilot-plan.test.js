import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSnapshotIndex, createLocalCanonicalAdapter } from '../scripts/catalog/snapshot-index.js';
import {
  PILOT_PLAN_VERSION,
  isExactGregorianDay,
  classifyPublicationDatePrecision,
  pilotDisqualificationReason,
  adaptCanonicalCandidateForScoring,
  buildIsbnMismatchDiagnostic,
  evaluateSourceEntry,
  generatePilotSummary,
  planCatalogPilot,
} from '../scripts/catalog/pilot-planner.js';

const execFileAsync = promisify(execFile);

function makeCandidate(overrides = {}) {
  return {
    recordId: 'edition-1',
    snapshotId: 'test-snapshot-2026',
    sourceName: 'open-library-bulk',
    isbn13: '9780141439518',
    title: 'Pride and Prejudice',
    subtitle: null,
    authors: ['Jane Austen'],
    language: 'en',
    publisher: 'Penguin Classics',
    publicationDate: '2003-05-14',
    publicationYear: 2003,
    format: 'Paperback',
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' },
    description: 'A classic novel.',
    subjects: ['Fiction', 'Romance'],
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL123M',
      openLibraryWorks: '/works/OL456W',
    },
    ...overrides,
  };
}

async function createTestIndex(candidates) {
  const directory = await mkdtemp(join(tmpdir(), 'bookish-pilot-test-'));
  const indexPath = join(directory, 'index');
  const asyncIterable = (async function* () {
    for (const c of candidates) yield c;
  })();
  await buildSnapshotIndex({
    records: asyncIterable,
    outputPath: indexPath,
    sourceName: 'open-library-bulk',
    snapshotId: 'test-snapshot-2026',
    generatedAt: '2026-09-15T00:00:00.000Z',
  });
  const adapter = await createLocalCanonicalAdapter({ indexPath });
  return { directory, indexPath, adapter };
}

test('1. Ordinary physical English edition can be selected', async t => {
  const candidate = makeCandidate();
  const { directory, adapter } = await createTestIndex([candidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const source = {
    key: 'pride-and-prejudice',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
  };

  const plan = await planCatalogPilot({ sources: [source], adapter });
  assert.equal(plan.planVersion, PILOT_PLAN_VERSION);
  assert.equal(plan.entries.length, 1);
  const entry = plan.entries[0];
  assert.equal(entry.status, 'selected');
  assert.equal(entry.selection.isbn13, '9780141439518');
  assert.equal(entry.selection.title, 'Pride and Prejudice');
  assert.deepEqual(entry.selection.authors, ['Jane Austen']);
  assert.equal(entry.selection.format, 'Paperback');
  assert.equal(entry.selection.publicationYear, 2003);
  assert.equal(entry.selection.publicationDate, '2003-05-14');
  assert.deepEqual(entry.selection.openLibraryWorks, ['/works/OL456W']);
  assert.equal(entry.selection.openLibraryEdition, '/books/OL123M');
  assert.equal(entry.quality.publicationDatePrecision, 'exact_day');
  assert.equal(entry.quality.hasCover, true);
  assert.equal(entry.quality.hasPublisher, true);
  assert.equal(entry.quality.hasMappedGenre, true);
  assert.deepEqual(entry.quality.mappedGenres, ['romance', 'fiction']);
});

test('2. Audiobook is rejected by pilot hard rejections', async t => {
  assert.equal(pilotDisqualificationReason({ format: 'Audiobook', title: 'Book' }), 'audiobook');
  assert.equal(pilotDisqualificationReason({ format: 'Audio CD', title: 'Book' }), 'audiobook');
  assert.equal(pilotDisqualificationReason({ format: 'Sound Recording', title: 'Book' }), 'audiobook');
  assert.equal(pilotDisqualificationReason({ format: null, title: 'Book (Audiobook)' }), 'audiobook');

  const audioCandidate = makeCandidate({
    recordId: 'edition-audio',
    format: 'Audiobook',
  });
  const { directory, adapter } = await createTestIndex([audioCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'no_match');
  assert.equal(plan.summary.rejectedByReason.rejected_audiobook, 1);
});

test('3. Ebook/digital edition is rejected by pilot hard rejections', async t => {
  assert.equal(pilotDisqualificationReason({ format: 'ebook', title: 'Book' }), 'ebook');
  assert.equal(pilotDisqualificationReason({ format: 'Kindle Edition', title: 'Book' }), 'ebook');
  assert.equal(pilotDisqualificationReason({ format: 'Electronic Resource', title: 'Book' }), 'ebook');
  assert.equal(pilotDisqualificationReason({ format: null, title: 'Book [electronic resource]' }), 'ebook');

  const ebookCandidate = makeCandidate({
    recordId: 'edition-ebook',
    format: 'Ebook',
  });
  const { directory, adapter } = await createTestIndex([ebookCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'no_match');
  assert.equal(plan.summary.rejectedByReason.rejected_ebook, 1);
});

test('4. Large-print edition is rejected for the pilot', async t => {
  assert.equal(pilotDisqualificationReason({ format: 'Large Print', title: 'Book' }), 'large_print');
  assert.equal(pilotDisqualificationReason({ format: 'Giant Print', title: 'Book' }), 'large_print');
  assert.equal(pilotDisqualificationReason({ format: null, title: 'Book (Large Print Edition)' }), 'large_print');

  const lpCandidate = makeCandidate({
    recordId: 'edition-lp',
    format: 'Large Print',
  });
  const { directory, adapter } = await createTestIndex([lpCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'no_match');
  assert.equal(plan.summary.rejectedByReason.rejected_large_print, 1);
});

test('5. Non-book / boxed-set / merchandise formats are rejected', async t => {
  assert.equal(pilotDisqualificationReason({ format: 'Boxed Set', title: 'Book' }), 'boxed_set');
  assert.equal(pilotDisqualificationReason({ format: 'Calendar', title: 'Book Calendar' }), 'calendar');
  assert.equal(pilotDisqualificationReason({ format: 'Blank Book', title: 'Journal' }), 'journal');
  assert.equal(pilotDisqualificationReason({ format: 'Tarot Deck', title: 'Cards' }), 'cards');
  assert.equal(pilotDisqualificationReason({ format: 'Board Game', title: 'Game' }), 'non_book');
  assert.equal(pilotDisqualificationReason({ format: 'Jigsaw Puzzle', title: 'Puzzle' }), 'non_book');

  const boxedCandidate = makeCandidate({
    recordId: 'edition-box',
    format: 'Boxed Set',
  });
  const { directory, adapter } = await createTestIndex([boxedCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'no_match');
  assert.equal(plan.summary.rejectedByReason.rejected_boxed_set, 1);
});

test('6. Known non-English edition is rejected via language semantics (not title mismatch)', async t => {
  const spanishCandidate = makeCandidate({
    recordId: 'edition-es',
    isbn13: '9780141439518',
    title: 'Pride and Prejudice',
    authors: ['Jane Austen'],
    language: 'spa',
  });
  const { directory, adapter } = await createTestIndex([spanishCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'no_match');
  assert.equal(plan.summary.rejectedByReason.rejected_non_english, 1);
});

test('7. Missing language does not automatically reject an otherwise good edition', async t => {
  const noLangCandidate = makeCandidate({
    recordId: 'edition-nolang',
    language: null,
  });
  const { directory, adapter } = await createTestIndex([noLangCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].selection.isbn13, noLangCandidate.isbn13);
  assert.ok(plan.entries[0].selection.reasons.includes('language_unknown'));
});

test('8. Preferred ISBN receives existing preference semantics', async t => {
  const candA = makeCandidate({
    recordId: 'edition-a',
    isbn13: '9780141439518',
    format: 'Paperback',
    publisher: 'Penguin',
  });
  const candB = makeCandidate({
    recordId: 'edition-b',
    isbn13: '9780451524935',
    format: 'Paperback',
    publisher: 'Signet',
  });

  const { directory, adapter } = await createTestIndex([candA, candB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      preferredIsbn13: '9780451524935',
      allowAlternateIsbn: true,
    }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].selection.isbn13, '9780451524935');
  assert.ok(plan.entries[0].selection.reasons.includes('preferred_isbn'));
});

test('9. Pinned ISBN semantics remain respected and never select alternate edition', async t => {
  const candPinned = makeCandidate({
    recordId: 'edition-pinned',
    isbn13: '9780141439518',
    publisher: 'Penguin',
    format: 'Paperback',
    cover: null,
    description: null,
  });
  const candAlternateStronger = makeCandidate({
    recordId: 'edition-alternate',
    isbn13: '9780451524935',
    publisher: 'Deluxe Press',
    format: 'Hardcover',
    cover: { url: 'https://example.test/deluxe.jpg', reference: 'cover-deluxe' },
    description: 'Extremely detailed deluxe edition description.',
  });

  const { directory, adapter } = await createTestIndex([candPinned, candAlternateStronger]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  // Source pinned to ISBN 9780141439518
  const plan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      pinnedIsbn13: '9780141439518',
    }],
    adapter,
  });

  // Valid pinned edition is selected, alternate is NOT silently chosen despite higher metadata score
  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].selection.isbn13, '9780141439518');

  // Test when pinned ISBN does not exist in local index: must return needs_review / pinned_isbn_mismatch
  const missingPinnedPlan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      pinnedIsbn13: '9781234567897',
    }],
    adapter,
  });
  assert.equal(missingPinnedPlan.entries[0].status, 'needs_review');
  assert.equal(missingPinnedPlan.entries[0].reason, 'pinned_isbn_mismatch');
});

test('10. No local candidates -> no_match', async t => {
  const { directory, adapter } = await createTestIndex([]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'unknown-book', title: 'Completely Nonexistent Book', author: 'Nobody' }],
    adapter,
  });
  assert.equal(plan.entries[0].status, 'no_match');
  assert.equal(plan.entries[0].reason, 'no_candidates_found');
  assert.equal(plan.entries[0].candidateCount, 0);
  assert.equal(plan.entries[0].selection, null);
});

test('11. Ambiguous / unsafe selection -> needs_review rather than guessing', async t => {
  const candA = makeCandidate({
    recordId: 'edition-a',
    isbn13: '9780141439518',
    publisher: 'Penguin',
  });
  const candB = makeCandidate({
    recordId: 'edition-b',
    isbn13: '9780451524935',
    publisher: 'Penguin',
  });

  const { directory, adapter } = await createTestIndex([candA, candB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'needs_review');
  assert.equal(plan.entries[0].reason, 'ambiguous_winner');
});

test('12. Candidate input order does not affect winner', async t => {
  const candBetter = makeCandidate({
    recordId: 'edition-better',
    isbn13: '9780141439518',
    format: 'Paperback',
    publisher: 'Penguin',
    cover: { url: 'https://example.test/cover.jpg', reference: 'ref-1' },
    description: 'Detailed description.',
  });
  const candLesser = makeCandidate({
    recordId: 'edition-lesser',
    isbn13: '9780451524935',
    format: null,
    publisher: null,
    cover: null,
    description: null,
  });

  const { directory: dir1, adapter: adapter1 } = await createTestIndex([candBetter, candLesser]);
  const { directory: dir2, adapter: adapter2 } = await createTestIndex([candLesser, candBetter]);
  t.after(() => Promise.all([
    fs.rm(dir1, { recursive: true, force: true }),
    fs.rm(dir2, { recursive: true, force: true }),
  ]));

  const source = { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' };
  const plan1 = await planCatalogPilot({ sources: [source], adapter: adapter1 });
  const plan2 = await planCatalogPilot({ sources: [source], adapter: adapter2 });

  assert.equal(plan1.entries[0].status, 'selected');
  assert.equal(plan2.entries[0].status, 'selected');
  assert.equal(plan1.entries[0].selection.isbn13, plan2.entries[0].selection.isbn13);
  assert.equal(plan1.entries[0].selection.score, plan2.entries[0].selection.score);
});

test('13. cover.reference counts as cover availability without fabricating a URL', async t => {
  const refCoverCandidate = makeCandidate({
    recordId: 'edition-ref',
    cover: { url: null, reference: 'open_library_cover_id:98765' },
  });
  const { directory, adapter } = await createTestIndex([refCoverCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].quality.hasCover, true);
  assert.equal(plan.summary.selectedQuality.withCover, 1);
  assert.equal(plan.summary.selectedQuality.withoutCover, 0);
  assert.ok(plan.entries[0].selection.reasons.includes('cover'));
});

test('14. Exact YYYY-MM-DD is classified exact_day', () => {
  assert.equal(isExactGregorianDay('2021-05-14'), true);
  assert.equal(isExactGregorianDay('2024-02-29'), true);
  assert.equal(isExactGregorianDay('2021-02-29'), false);
  assert.equal(isExactGregorianDay('2021-04-31'), false);
  assert.equal(isExactGregorianDay('2021'), false);
  assert.equal(isExactGregorianDay('May 2021'), false);

  assert.equal(classifyPublicationDatePrecision('2021-05-14', 2021), 'exact_day');
});

test('15. Year-only / partial dates are NOT converted to January 1 / first of month', () => {
  assert.equal(classifyPublicationDatePrecision('2021', 2021), 'year_or_partial');
  assert.equal(classifyPublicationDatePrecision('May 2021', 2021), 'year_or_partial');
  assert.equal(classifyPublicationDatePrecision('2021-05', 2021), 'year_or_partial');
  assert.equal(classifyPublicationDatePrecision(null, 2021), 'year_or_partial');
  assert.equal(classifyPublicationDatePrecision(null, null), 'unknown');
});

test('16. Controlled genre mapping is reported without DB writes', async t => {
  const candidate = makeCandidate({
    subjects: ['Science Fiction', 'Space Opera', 'Unknown Tag'],
  });
  const { directory, adapter } = await createTestIndex([candidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].quality.hasMappedGenre, true);
  assert.deepEqual(plan.entries[0].quality.mappedGenres, ['science-fiction']);
});

test('17. Aggregate summary counts and score confidence are deterministic', async t => {
  const candSelected = makeCandidate({
    recordId: 'edition-1',
    isbn13: '9780141439518',
    subjects: ['Romance'],
    publicationDate: '2003-05-14',
  });
  const candAudio = makeCandidate({
    recordId: 'edition-audio',
    isbn13: '9780451524935',
    title: 'Sense and Sensibility',
    authors: ['Jane Austen'],
    format: 'Audiobook',
  });

  const { directory, adapter } = await createTestIndex([candSelected, candAudio]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const sources = [
    { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    { key: 'sense-and-sensibility', title: 'Sense and Sensibility', author: 'Jane Austen' },
    { key: 'emma', title: 'Emma', author: 'Jane Austen' },
  ];

  const plan = await planCatalogPilot({ sources, adapter });
  assert.deepEqual(plan.summary, {
    requestedWorks: 3,
    selected: 1,
    needsReview: 0,
    noMatch: 2,
    candidateCount: 2,
    rejectedByReason: {
      rejected_audiobook: 1,
    },
    selectedQuality: {
      withCover: 1,
      withoutCover: 0,
      withPublisher: 1,
      withoutPublisher: 0,
      withMappedGenre: 1,
      withoutMappedGenre: 0,
      exactPublicationDate: 1,
      yearOrPartialPublicationDate: 0,
      unknownPublicationDate: 0,
    },
    selectionConfidence: {
      minScore: plan.entries[0].selection.score,
      medianScore: plan.entries[0].selection.score,
      maxScore: plan.entries[0].selection.score,
      lowConfidenceCount: 0,
    },
  });
});

test('18. CLI execution works with --source, --index, and --output arguments', async t => {
  const candidate = makeCandidate();
  const { directory, indexPath } = await createTestIndex([candidate]);
  const sourcePath = join(directory, 'source.json');
  const outputPath = join(directory, 'output-plan.json');

  await fs.writeFile(sourcePath, JSON.stringify([
    { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
  ]), 'utf8');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const { stdout } = await execFileAsync('node', [
    'scripts/catalog-pilot-plan.js',
    '--source', sourcePath,
    '--index', indexPath,
    '--output', outputPath,
  ]);

  assert.equal(stdout.trim(), '');
  const writtenPlan = JSON.parse(await fs.readFile(outputPath, 'utf8'));
  assert.equal(writtenPlan.planVersion, PILOT_PLAN_VERSION);
  assert.equal(writtenPlan.summary.selected, 1);
  assert.equal(writtenPlan.entries[0].selection.isbn13, '9780141439518');
});

test('19. Open Library work-identity ambiguity: conflicting distinct work IDs return needs_review', async t => {
  // Two plausible candidates with same requested title/author, but distinct OL work IDs
  const candWorkA = makeCandidate({
    recordId: 'edition-work-a',
    isbn13: '9780141439518',
    publisher: 'Penguin',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL100M',
      openLibraryWorks: '/works/OL100W',
    },
    // Higher metadata score
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' },
    description: 'Richer description.',
  });
  const candWorkB = makeCandidate({
    recordId: 'edition-work-b',
    isbn13: '9780451524935',
    publisher: 'Signet',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL200M',
      openLibraryWorks: '/works/OL200W',
    },
    cover: null,
    description: null,
  });

  const { directory, adapter } = await createTestIndex([candWorkA, candWorkB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'needs_review');
  assert.equal(plan.entries[0].reason, 'conflicting_open_library_works');
  assert.deepEqual(plan.entries[0].conflictingWorkIds, ['/works/OL100W', '/works/OL200W']);
  assert.equal(plan.entries[0].selection, null);
});

test('20. Same Open Library work ID across multiple editions proceeds to normal edition selection', async t => {
  const candA = makeCandidate({
    recordId: 'edition-work-same-a',
    isbn13: '9780141439518',
    publisher: 'Penguin',
    format: 'Paperback',
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' },
    description: 'Detailed description.',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL100M',
      openLibraryWorks: '/works/OL100W',
    },
  });
  const candB = makeCandidate({
    recordId: 'edition-work-same-b',
    isbn13: '9780451524935',
    publisher: null,
    format: null,
    cover: null,
    description: null,
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL101M',
      openLibraryWorks: '/works/OL100W',
    },
  });

  const { directory, adapter } = await createTestIndex([candA, candB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  assert.deepEqual(plan.entries[0].selection.openLibraryWorks, ['/works/OL100W']);
});

test('21. Planner explicitly performs no network calls (throws if fetch is called)', async t => {
  const candidate = makeCandidate();
  const { directory, adapter } = await createTestIndex([candidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Network disabled: no network calls allowed in local pilot planner');
  };

  try {
    const plan = await planCatalogPilot({
      sources: [{ key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' }],
      adapter,
    });
    assert.equal(plan.entries[0].status, 'selected');
    assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('22. Pinned exact ISBN with unrelated alternate OL work IDs is selected and not blocked by conflicting_open_library_works', async t => {
  const candWorkA = makeCandidate({
    recordId: 'edition-work-a',
    isbn13: '9780141439518',
    publisher: 'Penguin',
    format: 'Paperback',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL100M',
      openLibraryWorks: '/works/OL100W',
    },
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' },
    description: 'Target pinned edition description.',
  });
  const candWorkB = makeCandidate({
    recordId: 'edition-work-b',
    isbn13: '9780451524935',
    publisher: 'Signet',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL200M',
      openLibraryWorks: '/works/OL200W',
    },
    cover: null,
    description: null,
  });

  const { directory, adapter } = await createTestIndex([candWorkA, candWorkB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      pinnedIsbn13: '9780141439518',
    }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  assert.deepEqual(plan.entries[0].selection.openLibraryWorks, ['/works/OL100W']);
});

test('23. preferredIsbn13 with allowAlternateIsbn=false is selected and not blocked by conflicting_open_library_works', async t => {
  const candWorkA = makeCandidate({
    recordId: 'edition-work-a',
    isbn13: '9780141439518',
    publisher: 'Penguin',
    format: 'Paperback',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL100M',
      openLibraryWorks: '/works/OL100W',
    },
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' },
    description: 'Target preferred edition description.',
  });
  const candWorkB = makeCandidate({
    recordId: 'edition-work-b',
    isbn13: '9780451524935',
    publisher: 'Signet',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL200M',
      openLibraryWorks: '/works/OL200W',
    },
    cover: null,
    description: null,
  });

  const { directory, adapter } = await createTestIndex([candWorkA, candWorkB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      preferredIsbn13: '9780141439518',
      allowAlternateIsbn: false,
    }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'selected');
  assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  assert.deepEqual(plan.entries[0].selection.openLibraryWorks, ['/works/OL100W']);
});

test('24. preferredIsbn13 with allowAlternateIsbn=true considers alternates and preserves work-conflict protection', async t => {
  const candWorkA = makeCandidate({
    recordId: 'edition-work-a',
    isbn13: '9780141439518',
    publisher: 'Penguin',
    format: 'Paperback',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL100M',
      openLibraryWorks: '/works/OL100W',
    },
    cover: { url: 'https://example.test/cover.jpg', reference: 'cover-1' },
  });
  const candWorkB = makeCandidate({
    recordId: 'edition-work-b',
    isbn13: '9780451524935',
    publisher: 'Signet',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL200M',
      openLibraryWorks: '/works/OL200W',
    },
    cover: null,
  });

  const { directory, adapter } = await createTestIndex([candWorkA, candWorkB]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const plan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      preferredIsbn13: '9781234567897',
      allowAlternateIsbn: true,
    }],
    adapter,
  });

  assert.equal(plan.entries[0].status, 'needs_review');
  assert.equal(plan.entries[0].reason, 'conflicting_open_library_works');
  assert.deepEqual(plan.entries[0].conflictingWorkIds, ['/works/OL100W', '/works/OL200W']);
});

test('25. Missing pinned or preferred ISBN produces mismatch with diagnostics when candidate was not in index', async t => {
  const candA = makeCandidate({
    recordId: 'edition-present',
    isbn13: '9780141439518',
  });
  const { directory, adapter } = await createTestIndex([candA]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  // Missing pinned ISBN
  const pinnedPlan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      pinnedIsbn13: '9781234567897',
    }],
    adapter,
  });
  assert.equal(pinnedPlan.entries[0].status, 'needs_review');
  assert.equal(pinnedPlan.entries[0].reason, 'pinned_isbn_mismatch');
  assert.equal(pinnedPlan.entries[0].expectedIsbn13, '9781234567897');
  assert.equal(pinnedPlan.entries[0].existedBeforeEligibility, false);
  assert.deepEqual(pinnedPlan.entries[0].rejectionReasons, []);
  assert.equal(pinnedPlan.entries[0].candidateRecordId, null);
  assert.equal(pinnedPlan.entries[0].openLibraryEditionId, null);

  // Missing preferred ISBN with allowAlternateIsbn=false
  const preferredPlan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      preferredIsbn13: '9781234567897',
      allowAlternateIsbn: false,
    }],
    adapter,
  });
  assert.equal(preferredPlan.entries[0].status, 'needs_review');
  assert.equal(preferredPlan.entries[0].reason, 'preferred_isbn_mismatch');
  assert.equal(preferredPlan.entries[0].expectedIsbn13, '9781234567897');
  assert.equal(preferredPlan.entries[0].existedBeforeEligibility, false);
  assert.deepEqual(preferredPlan.entries[0].rejectionReasons, []);
  assert.equal(preferredPlan.entries[0].candidateRecordId, null);
  assert.equal(preferredPlan.entries[0].openLibraryEditionId, null);
});

test('26. Ineligible pinned or preferred ISBN produces mismatch with diagnostics explaining why candidate was rejected', async t => {
  const ineligibleCandidate = makeCandidate({
    recordId: 'edition-boxed-1',
    isbn13: '9780141439518',
    format: 'Boxed Set',
    sourceIdentifiers: {
      openLibraryEdition: '/books/OL999M',
      openLibraryWorks: '/works/OL999W',
    },
  });
  const validCandidate = makeCandidate({
    recordId: 'edition-valid-1',
    isbn13: '9780451524935',
    format: 'Paperback',
  });

  const { directory, adapter } = await createTestIndex([ineligibleCandidate, validCandidate]);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  // Ineligible pinned ISBN
  const pinnedPlan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      pinnedIsbn13: '9780141439518',
    }],
    adapter,
  });
  assert.equal(pinnedPlan.entries[0].status, 'needs_review');
  assert.equal(pinnedPlan.entries[0].reason, 'pinned_isbn_mismatch');
  assert.equal(pinnedPlan.entries[0].expectedIsbn13, '9780141439518');
  assert.equal(pinnedPlan.entries[0].existedBeforeEligibility, true);
  assert.deepEqual(pinnedPlan.entries[0].rejectionReasons, ['rejected_boxed_set']);
  assert.equal(pinnedPlan.entries[0].candidateRecordId, 'edition-boxed-1');
  assert.equal(pinnedPlan.entries[0].openLibraryEditionId, '/books/OL999M');

  // Ineligible preferred ISBN with allowAlternateIsbn=false
  const preferredPlan = await planCatalogPilot({
    sources: [{
      key: 'pride-and-prejudice',
      title: 'Pride and Prejudice',
      author: 'Jane Austen',
      preferredIsbn13: '9780141439518',
      allowAlternateIsbn: false,
    }],
    adapter,
  });
  assert.equal(preferredPlan.entries[0].status, 'needs_review');
  assert.equal(preferredPlan.entries[0].reason, 'preferred_isbn_mismatch');
  assert.equal(preferredPlan.entries[0].expectedIsbn13, '9780141439518');
  assert.equal(preferredPlan.entries[0].existedBeforeEligibility, true);
  assert.deepEqual(preferredPlan.entries[0].rejectionReasons, ['rejected_boxed_set']);
  assert.equal(preferredPlan.entries[0].candidateRecordId, 'edition-boxed-1');
  assert.equal(preferredPlan.entries[0].openLibraryEditionId, '/books/OL999M');
});

test('27. buildIsbnMismatchDiagnostic helper handles matching, missing, and reasons deduplication', () => {
  const diagNotFound = buildIsbnMismatchDiagnostic('9781111111111', [], []);
  assert.deepEqual(diagNotFound, {
    expectedIsbn13: '9781111111111',
    existedBeforeEligibility: false,
    rejectionReasons: [],
    candidateRecordId: null,
    openLibraryEditionId: null,
  });

  const cand = {
    recordId: 'rec-1',
    isbn13: '9782222222222',
    sourceIdentifiers: { openLibraryEdition: 'OL222M' },
  };
  const ev1 = {
    isbn: '9782222222222',
    eligible: false,
    reasons: ['rejected_calendar', 'format_invalid'],
  };
  const ev2 = {
    isbn: '9782222222222',
    eligible: false,
    reasons: ['format_invalid', 'language_mismatch'],
  };
  const diagFound = buildIsbnMismatchDiagnostic('9782222222222', [cand], [ev1, ev2]);
  assert.deepEqual(diagFound, {
    expectedIsbn13: '9782222222222',
    existedBeforeEligibility: true,
    rejectionReasons: ['rejected_calendar', 'format_invalid', 'language_mismatch'],
    candidateRecordId: 'rec-1',
    openLibraryEditionId: 'OL222M',
  });
});

