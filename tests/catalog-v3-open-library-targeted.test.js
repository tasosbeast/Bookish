import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildTargetedOpenLibraryArtifact,
  createTargetedCanonicalAdapter,
  readTargetedArtifactMetadata,
} from '../scripts/catalog/open-library-targeted.js';
import { CatalogContractError } from '../scripts/catalog/contracts.js';
import { buildSnapshotIndex } from '../scripts/catalog/snapshot-index.js';
import {
  buildOpenLibraryAuthorIndex,
  buildOpenLibraryAuthorLookup,
} from '../scripts/catalog/open-library-bulk.js';

const execFileAsync = promisify(execFile);
const SNAPSHOT_ID = 'open-library-2026-08-31';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bookish-targeted-test-'));
  const cleanups = [];
  const track = (resource) => {
    cleanups.push(resource);
    return resource;
  };
  try {
    await fn({ dir, track });
  } finally {
    for (const resource of cleanups.reverse()) {
      try {
        if (typeof resource === 'function') await resource();
        else if (typeof resource?.close === 'function') resource.close();
      } catch {}
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function dumpLine({
  key,
  title,
  isbn13,
  authors = [{ key: '/authors/OL1A' }],
  isbn10 = [],
  format = 'Paperback',
  publishers = ['Penguin Classics'],
  publishDate = '2003-05-14',
}) {
  const data = {
    title,
    authors,
    isbn_13: Array.isArray(isbn13) ? isbn13 : (isbn13 ? [isbn13] : []),
    publishers,
    physical_format: format,
    publish_date: publishDate,
    languages: [{ key: '/languages/eng' }],
  };
  if (isbn10.length) data.isbn_10 = isbn10;
  return `/type/edition\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify(data)}\n`;
}

function authorDumpLine({ key, name }) {
  return `/type/author\t${key}\t1\t2026-01-01T00:00:00.000000\t${JSON.stringify({ name })}\n`;
}

async function createAuthorIndex(directory, authors) {
  const authorsFile = join(directory, 'authors.txt');
  const authorIndexDir = join(directory, 'authors-index');
  await fs.writeFile(authorsFile, authors.map(authorDumpLine).join(''));
  await buildOpenLibraryAuthorIndex({
    inputPath: authorsFile,
    outputPath: authorIndexDir,
    snapshotId: SNAPSHOT_ID,
    generatedAt: '2026-09-01T00:00:00.000Z',
  });
  await buildOpenLibraryAuthorLookup({
    indexPath: authorIndexDir,
    snapshotId: SNAPSHOT_ID,
    batchSize: 10,
  });
  return authorIndexDir;
}

test('1. irrelevant edition is skipped before author lookup', async () => {
  await withTempDir(async ({ dir }) => {
    let authorLookupsCalled = 0;
    const mockAuthorLookup = {
      async getNames(keys) {
        authorLookupsCalled += 1;
        return new Map(keys.map(k => [k, 'Some Author']));
      },
      close() {},
    };

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLIRRELEVANT1M',
      title: 'Advanced Linear Algebra',
      isbn13: '9780123456789',
      authors: [{ key: '/authors/OLRANDOM' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
        preferredIsbn13: '9780141439518',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorLookup: mockAuthorLookup,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(authorLookupsCalled, 0, 'author lookup should not be called for irrelevant rows');
    assert.equal(result.statistics.rowsScanned, 1);
    assert.equal(result.statistics.rowsPassingTitlePrefilter, 0);
    assert.equal(result.statistics.rowsPassingIsbnPrefilter, 0);
    assert.equal(result.statistics.authorLookupsPerformed, 0);
    assert.equal(result.statistics.matchedEditions, 0);
    assert.equal(result.statistics.canonicalCandidates, 0);
    assert.equal(result.statistics.uniqueCandidateAssociations, 0);
    assert.equal(result.statistics.requestedWorksWithCandidates, 0);
    assert.equal(result.statistics.requestedWorksWithoutCandidates, 1);
  });
});

test('2. exact normalized title + exact normalized primary author retrieves candidates', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'The Pride and Prejudice!',
        author: 'Austen, Jane',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.matchedEditions, 1);
    assert.equal(result.statistics.canonicalCandidates, 1);
    assert.equal(result.statistics.uniqueCandidateAssociations, 1);

    const adapter = track(await createTargetedCanonicalAdapter({
      artifactPath: outputPath,
      sourceManifest: sources,
    }));

    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].isbn13, '9780141439518');
    assert.equal(candidates[0].title, 'Pride and Prejudice');
    assert.deepEqual(candidates[0].authors, ['Jane Austen']);
  });
});

test('3. title match with wrong author does not associate candidate through the title path', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL2A', name: 'Charles Dickens' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL101M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL2A' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.rowsPassingTitlePrefilter, 1);
    assert.equal(result.statistics.authorLookupsPerformed, 1);
    assert.equal(result.statistics.matchedEditions, 0);
    assert.equal(result.statistics.canonicalCandidates, 0);
    assert.equal(result.statistics.uniqueCandidateAssociations, 0);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 0);
  });
});

test('4. exact preferred ISBN retrieves its candidate even when title/author does not match', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL102M',
      title: 'Different Title Entirely',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'my-preferred-book',
        title: 'Requested Title',
        author: 'Requested Author',
        preferredIsbn13: '9780141439518',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.rowsPassingIsbnPrefilter, 1);
    assert.equal(result.statistics.matchedEditions, 1);
    assert.equal(result.statistics.uniqueCandidateAssociations, 1);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].isbn13, '9780141439518');
  });
});

test('5. pinned ISBN behaves likewise', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL103M',
      title: 'Unrelated Title',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'my-pinned-book',
        title: 'Original Title',
        author: 'Original Author',
        pinnedIsbn13: '9780141439518',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.matchedEditions, 1);
    assert.equal(result.statistics.uniqueCandidateAssociations, 1);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].isbn13, '9780141439518');
  });
});

test('6. an edition reached by both ISBN and title-author paths is deduplicated', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL104M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
        preferredIsbn13: '9780141439518',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.rowsPassingTitlePrefilter, 1);
    assert.equal(result.statistics.rowsPassingIsbnPrefilter, 1);
    assert.equal(result.statistics.matchedEditions, 1);
    assert.equal(result.statistics.uniqueCandidateAssociations, 1, 'candidate should be deduplicated to exactly 1 association');

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
  });
});

test('7. an edition with multiple valid ISBNs: title-author receives all candidates; exact-ISBN-only receives only exact candidate', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLMULTI1M',
      title: 'Pride and Prejudice',
      isbn13: ['9780141439518', '9780451524935'],
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'source-title-author',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
      },
      {
        key: 'source-exact-isbn-only',
        title: 'Unrelated Work',
        author: 'Unrelated Author',
        preferredIsbn13: '9780141439518',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.matchedEditions, 1);
    assert.equal(result.statistics.canonicalCandidates, 2);
    assert.equal(result.statistics.uniqueCandidateAssociations, 3); // 2 for source-title-author, 1 for source-exact-isbn-only

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));

    const candidatesTitleAuthor = await adapter.getCandidates(sources[0]);
    assert.equal(candidatesTitleAuthor.length, 2, 'title-author source receives all valid candidates');
    assert.ok(candidatesTitleAuthor.some(c => c.isbn13 === '9780141439518'));
    assert.ok(candidatesTitleAuthor.some(c => c.isbn13 === '9780451524935'));

    const candidatesExactIsbn = await adapter.getCandidates(sources[1]);
    assert.equal(candidatesExactIsbn.length, 1, 'exact-ISBN source receives only the matching candidate');
    assert.equal(candidatesExactIsbn[0].isbn13, '9780141439518');
  });
});

test('8. malformed ISBN identifiers preserve existing canonical/error semantics where relevant', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLMALFORMEDISBN1M',
      title: 'Pride and Prejudice',
      isbn13: ['not-a-valid-isbn', '9780141439518'],
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.matchedEditions, 1);
    assert.equal(result.statistics.canonicalCandidates, 1);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].isbn13, '9780141439518');
  });
});

test('9. missing/conflicting author resolution cannot create a false title-author match', async () => {
  await withTempDir(async ({ dir, track }) => {
    const mockConflictedLookup = {
      async getNames() {
        return null;
      },
      close() {},
    };

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLCONFLICT1M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OLMISSING' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorLookup: mockConflictedLookup,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.rowsPassingTitlePrefilter, 1);
    assert.equal(result.statistics.authorLookupsPerformed, 1);
    assert.equal(result.statistics.matchedEditions, 0, 'missing/conflicted author must not match title-author');
    assert.equal(result.statistics.uniqueCandidateAssociations, 0);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 0);
  });
});

test('10. artifact build is atomic and a failed rebuild preserves known-good output', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      {
        key: 'pride-and-prejudice',
        title: 'Pride and Prejudice',
        author: 'Jane Austen',
      },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    const adapter1 = await createTargetedCanonicalAdapter({ artifactPath: outputPath });
    const candidatesBefore = await adapter1.getCandidates(sources[0]);
    assert.equal(candidatesBefore.length, 1);
    adapter1.close();

    const failingAuthorLookup = {
      async getNames() {
        throw new Error('Simulated author lookup hardware crash');
      },
      close() {},
    };

    await assert.rejects(
      () => buildTargetedOpenLibraryArtifact({
        sources,
        inputPath: dumpPath,
        authorLookup: failingAuthorLookup,
        outputPath,
        snapshotId: SNAPSHOT_ID,
      }),
      /Simulated author lookup hardware crash/,
    );

    const adapter2 = await createTargetedCanonicalAdapter({ artifactPath: outputPath });
    const candidatesAfter = await adapter2.getCandidates(sources[0]);
    assert.equal(candidatesAfter.length, 1, 'known-good artifact should be preserved after failed build');
    adapter2.close();

    const files = await fs.readdir(dir);
    assert.ok(!files.some(f => f.includes('.building-')), 'temporary building artifacts must be cleaned up on failure');
  });
});

test('11. invalid/corrupt targeted artifact fails clearly', async () => {
  await withTempDir(async ({ dir }) => {
    const corruptPath = join(dir, 'corrupt.sqlite');
    await fs.writeFile(corruptPath, 'THIS IS NOT A SQLITE FILE');

    await assert.rejects(
      () => readTargetedArtifactMetadata(corruptPath),
      (err) => err instanceof CatalogContractError && err.code === 'invalid_targeted_artifact',
    );

    await assert.rejects(
      () => createTargetedCanonicalAdapter({ artifactPath: corruptPath }),
      (err) => err instanceof CatalogContractError && err.code === 'invalid_targeted_artifact',
    );
  });
});

test('12. source-manifest mismatch fails clearly', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const manifestA = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];
    const manifestB = [
      { key: 'sense-and-sensibility', title: 'Sense and Sensibility', author: 'Jane Austen' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    await buildTargetedOpenLibraryArtifact({
      sources: manifestA,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    await assert.rejects(
      () => createTargetedCanonicalAdapter({
        artifactPath: outputPath,
        sourceManifest: manifestB,
      }),
      (err) => err instanceof CatalogContractError && err.code === 'source_manifest_mismatch',
    );
  });
});

test('13. targeted canonical adapter returns only requested source candidates', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
      { key: '/authors/OL2A', name: 'Mary Shelley' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, [
      dumpLine({ key: '/books/OL100M', title: 'Pride and Prejudice', isbn13: '9780141439518', authors: [{ key: '/authors/OL1A' }] }),
      dumpLine({ key: '/books/OL200M', title: 'Frankenstein', isbn13: '9780141439471', authors: [{ key: '/authors/OL2A' }] }),
    ].join(''));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
      { key: 'frankenstein', title: 'Frankenstein', author: 'Mary Shelley' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));

    const prideCandidates = await adapter.getCandidates(sources[0]);
    assert.equal(prideCandidates.length, 1);
    assert.equal(prideCandidates[0].isbn13, '9780141439518');

    const frankensteinCandidates = await adapter.getCandidates(sources[1]);
    assert.equal(frankensteinCandidates.length, 1);
    assert.equal(frankensteinCandidates[0].isbn13, '9780141439471');

    const unknownCandidates = await adapter.getCandidates({
      key: 'unknown-book',
      title: 'Unknown Title',
      author: 'Unknown Author',
    });
    assert.equal(unknownCandidates.length, 0);
  });
});

test('14. pilot planner produces valid output using --targeted', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];
    const sourcePath = join(dir, 'sources.json');
    await fs.writeFile(sourcePath, JSON.stringify(sources, null, 2));

    const targetedPath = join(dir, 'targeted.sqlite');
    await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath: targetedPath,
      snapshotId: SNAPSHOT_ID,
    });

    const planPath = join(dir, 'plan.json');
    const cliScript = join(process.cwd(), 'scripts', 'catalog-pilot-plan.js');

    const result = await execFileAsync(process.execPath, [
      '--experimental-sqlite',
      cliScript,
      '--source', sourcePath,
      '--targeted', targetedPath,
      '--output', planPath,
    ]);

    assert.equal(result.stderr, '');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    assert.equal(plan.planVersion, 1);
    assert.equal(plan.summary.requestedWorks, 1);
    assert.equal(plan.summary.selected, 1);
    assert.equal(plan.entries[0].status, 'selected');
    assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  });
});

test('15. existing --index pilot planner path still works unchanged', async () => {
  await withTempDir(async ({ dir }) => {
    const candidate = {
      recordId: 'edition-1',
      snapshotId: SNAPSHOT_ID,
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
    };

    const indexPath = join(dir, 'snapshot-index');
    const asyncIterable = (async function* () {
      yield candidate;
    })();
    await buildSnapshotIndex({
      records: asyncIterable,
      outputPath: indexPath,
      sourceName: 'open-library-bulk',
      snapshotId: SNAPSHOT_ID,
      generatedAt: '2026-09-01T00:00:00.000Z',
    });

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];
    const sourcePath = join(dir, 'sources.json');
    await fs.writeFile(sourcePath, JSON.stringify(sources, null, 2));

    const planPath = join(dir, 'plan.json');
    const cliScript = join(process.cwd(), 'scripts', 'catalog-pilot-plan.js');

    const result = await execFileAsync(process.execPath, [
      '--experimental-sqlite',
      cliScript,
      '--source', sourcePath,
      '--index', indexPath,
      '--output', planPath,
    ]);

    assert.equal(result.stderr, '');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    assert.equal(plan.planVersion, 1);
    assert.equal(plan.summary.selected, 1);
    assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  });
});

test('16. no network access is required and CLI tool executes completely offline', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];
    const sourcePath = join(dir, 'sources.json');
    await fs.writeFile(sourcePath, JSON.stringify(sources, null, 2));

    const outputPath = join(dir, 'targeted.sqlite');
    const extractScript = join(process.cwd(), 'scripts', 'ol-targeted-extract.js');

    const result = await execFileAsync(process.execPath, [
      '--experimental-sqlite',
      extractScript,
      '--source', sourcePath,
      '--input', dumpPath,
      '--author-index', authorIndexDir,
      '--output', outputPath,
      '--snapshot-id', SNAPSHOT_ID,
      '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.statistics.matchedEditions, 1);
    assert.equal(parsed.statistics.canonicalCandidates, 1);
    assert.equal(parsed.statistics.uniqueCandidateAssociations, 1);
  });
});
