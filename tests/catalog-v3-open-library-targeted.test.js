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
  validateBuiltTargetedArtifact,
} from '../scripts/catalog/open-library-targeted.js';
import { CatalogContractError } from '../scripts/catalog/contracts.js';
import { buildSnapshotIndex } from '../scripts/catalog/snapshot-index.js';
import {
  buildOpenLibraryAuthorIndex,
  shardFor,
  shardName,
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

async function createAuthorIndex(directory, authors, { snapshotId = SNAPSHOT_ID } = {}) {
  const authorsFile = join(directory, 'authors.txt');
  const authorIndexDir = join(directory, 'authors-index');
  await fs.writeFile(authorsFile, authors.map(authorDumpLine).join(''));
  await buildOpenLibraryAuthorIndex({
    inputPath: authorsFile,
    outputPath: authorIndexDir,
    snapshotId,
    generatedAt: '2026-09-01T00:00:00.000Z',
  });
  // Note: We deliberately do NOT call buildOpenLibraryAuthorLookup here.
  // No lookup.sqlite is created.
  return authorIndexDir;
}

test('1. targeted extraction succeeds with NO lookup.sqlite present', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const lookupExists = await fs.access(join(authorIndexDir, 'lookup.sqlite')).then(() => true).catch(() => false);
    assert.equal(lookupExists, false, 'lookup.sqlite must not exist in author index');

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
    assert.equal(result.statistics.canonicalCandidates, 1);
    assert.equal(result.statistics.distinctAuthorKeysNeeded, 1);
    assert.equal(result.statistics.authorKeysResolved, 1);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath, sourceManifest: sources }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].isbn13, '9780141439518');
  });
});

test('2. createOpenLibraryAuthorLookup is never needed by the targeted extractor', async () => {
  const targetedModulePath = join(process.cwd(), 'scripts', 'catalog', 'open-library-targeted.js');
  const code = await fs.readFile(targetedModulePath, 'utf8');
  assert.equal(
    code.includes('createOpenLibraryAuthorLookup'),
    false,
    'open-library-targeted.js must not reference or call createOpenLibraryAuthorLookup',
  );
});

test('3. irrelevant edition rows do not cause any author shard read', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

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
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.rowsScanned, 1);
    assert.equal(result.statistics.rowsPassingTitlePrefilter, 0);
    assert.equal(result.statistics.rowsPassingIsbnPrefilter, 0);
    assert.equal(result.statistics.pendingEditions, 0);
    assert.equal(result.statistics.distinctAuthorKeysNeeded, 0);
    assert.equal(result.statistics.authorShardsScanned, 0);
    assert.equal(result.statistics.authorRowsScanned, 0);
    assert.equal(result.statistics.matchedEditions, 0);
  });
});

test('4. only shards containing requested author keys are opened', async () => {
  await withTempDir(async ({ dir }) => {
    const key1 = '/authors/OL1A';
    const shard1 = shardFor(key1);
    let key2 = null;
    for (let i = 2; i < 1000; i++) {
      const candidate = `/authors/OL${i}A`;
      if (shardFor(candidate) !== shard1) {
        key2 = candidate;
        break;
      }
    }
    assert.ok(key2, 'must find key with different shard');

    const authorIndexDir = await createAuthorIndex(dir, [
      { key: key1, name: 'Jane Austen' },
      { key: key2, name: 'Charlotte Bronte' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: key1 }],
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.distinctAuthorKeysNeeded, 1);
    assert.equal(result.statistics.authorShardsScanned, 1, 'only the shard containing key1 should be scanned');
    assert.equal(result.statistics.authorKeysResolved, 1);
  });
});

test('5. each requested author shard is streamed at most once', async () => {
  await withTempDir(async ({ dir }) => {
    const key1 = '/authors/OL1A';
    const shard1 = shardFor(key1);
    let key2 = null;
    for (let i = 2; i < 10000; i++) {
      const candidate = `/authors/OL${i}A`;
      if (shardFor(candidate) === shard1) {
        key2 = candidate;
        break;
      }
    }
    assert.ok(key2, 'must find second key in same shard');

    const authorIndexDir = await createAuthorIndex(dir, [
      { key: key1, name: 'Jane Austen' },
      { key: key2, name: 'Another Author In Same Shard' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, [
      dumpLine({ key: '/books/OL100M', title: 'Pride and Prejudice', isbn13: '9780141439518', authors: [{ key: key1 }] }),
      dumpLine({ key: '/books/OL200M', title: 'Second Work', isbn13: '9780141439525', authors: [{ key: key2 }] }),
    ].join(''));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
      { key: 'second-work', title: 'Second Work', author: 'Another Author In Same Shard' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.distinctAuthorKeysNeeded, 2);
    assert.equal(result.statistics.authorShardsScanned, 1, 'shard shared by both keys must be streamed only once');
    assert.equal(result.statistics.authorKeysResolved, 2);
  });
});

test('6. author resolution memory/state contains only requested keys, not complete shard contents', async () => {
  await withTempDir(async ({ dir }) => {
    const key1 = '/authors/OL1A';
    const shard1 = shardFor(key1);
    const unneededKeys = [];
    for (let i = 2; unneededKeys.length < 4; i++) {
      const candidate = `/authors/OL${i}A`;
      if (shardFor(candidate) === shard1) {
        unneededKeys.push(candidate);
      }
    }

    const allAuthors = [
      { key: key1, name: 'Jane Austen' },
      ...unneededKeys.map((k, idx) => ({ key: k, name: `Unneeded Author ${idx + 1}` })),
    ];

    const authorIndexDir = await createAuthorIndex(dir, allAuthors);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: key1 }],
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.distinctAuthorKeysNeeded, 1);
    assert.equal(result.statistics.authorRowsScanned, 5, 'all rows in shard are scanned');
    assert.equal(result.statistics.authorKeysResolved, 1, 'only the single requested key is resolved');
  });
});

test('7. exact title + primary-author retrieval still works', async () => {
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

test('8. wrong author does not associate through title path', async () => {
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
    assert.equal(result.statistics.matchedEditions, 0);
    assert.equal(result.statistics.canonicalCandidates, 0);
    assert.equal(result.statistics.uniqueCandidateAssociations, 0);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 0);
  });
});

test('9. preferred ISBN still works despite title/author mismatch', async () => {
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

test('10. pinned ISBN still works despite title/author mismatch', async () => {
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

test('11. multi-ISBN title match still receives all canonical ISBN candidates', async () => {
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
    assert.equal(result.statistics.uniqueCandidateAssociations, 2);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.some(c => c.isbn13 === '9780141439518'));
    assert.ok(candidates.some(c => c.isbn13 === '9780451524935'));
  });
});

test('12. exact-ISBN-only source receives only the exact ISBN candidate', async () => {
  await withTempDir(async ({ dir, track }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLMULTI2M',
      title: 'Pride and Prejudice',
      isbn13: ['9780141439518', '9780451524935'],
      authors: [{ key: '/authors/OL1A' }],
    }));

    const sources = [
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
    assert.equal(result.statistics.uniqueCandidateAssociations, 1);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].isbn13, '9780141439518');
  });
});

test('13. duplicate title+ISBN path remains deduplicated', async () => {
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

test('14. missing author key causes no false title-author match', async () => {
  await withTempDir(async ({ dir, track }) => {
    // Author index has no OLNONEXISTENT
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLMISSING1M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: '/authors/OLNONEXISTENT' }],
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
    assert.equal(result.statistics.distinctAuthorKeysNeeded, 1);
    assert.equal(result.statistics.authorKeysMissing, 1);
    assert.equal(result.statistics.matchedEditions, 0, 'missing author key must not match title-author');
    assert.equal(result.statistics.uniqueCandidateAssociations, 0);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 0);
  });
});

test('15. conflicting author names cause no false title-author match', async () => {
  await withTempDir(async ({ dir, track }) => {
    // Author index has conflicting names for /authors/OL1A
    const authorsFile = join(dir, 'authors.txt');
    const authorIndexDir = join(dir, 'authors-index');
    await fs.writeFile(authorsFile, [
      authorDumpLine({ key: '/authors/OL1A', name: 'Jane Austen' }),
      authorDumpLine({ key: '/authors/OL1A', name: 'Different Name Person' }),
    ].join(''));
    await buildOpenLibraryAuthorIndex({
      inputPath: authorsFile,
      outputPath: authorIndexDir,
      snapshotId: SNAPSHOT_ID,
      generatedAt: '2026-09-01T00:00:00.000Z',
    });

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OLCONFLICT1M',
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
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    assert.equal(result.statistics.rowsPassingTitlePrefilter, 1);
    assert.equal(result.statistics.distinctAuthorKeysNeeded, 1);
    assert.equal(result.statistics.authorKeysConflicted, 1);
    assert.equal(result.statistics.matchedEditions, 0, 'conflicted author must not match title-author');
    assert.equal(result.statistics.uniqueCandidateAssociations, 0);

    const adapter = track(await createTargetedCanonicalAdapter({ artifactPath: outputPath }));
    const candidates = await adapter.getCandidates(sources[0]);
    assert.equal(candidates.length, 0);
  });
});

test('16. author-index snapshot mismatch fails clearly', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ], { snapshotId: 'open-library-2025-01-01' });

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    await assert.rejects(
      () => buildTargetedOpenLibraryArtifact({
        sources,
        inputPath: dumpPath,
        authorIndexPath: authorIndexDir,
        outputPath,
        snapshotId: SNAPSHOT_ID,
      }),
      (err) => err instanceof CatalogContractError && err.code === 'author_snapshot_mismatch',
    );
  });
});

test('17. corrupt/incompatible author index fails clearly', async () => {
  await withTempDir(async ({ dir }) => {
    const corruptAuthorDir = join(dir, 'corrupt-authors');
    await fs.mkdir(corruptAuthorDir, { recursive: true });
    await fs.writeFile(join(corruptAuthorDir, 'index.json'), '{ "bad": true }');

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];

    const outputPath = join(dir, 'targeted.sqlite');
    await assert.rejects(
      () => buildTargetedOpenLibraryArtifact({
        sources,
        inputPath: dumpPath,
        authorIndexPath: corruptAuthorDir,
        outputPath,
        snapshotId: SNAPSHOT_ID,
      }),
      (err) => err instanceof CatalogContractError && err.code === 'invalid_author_index',
    );
  });
});

test('18. failed build preserves existing known-good targeted artifact', async () => {
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

    const nonExistentDump = join(dir, 'does-not-exist.txt');

    await assert.rejects(
      () => buildTargetedOpenLibraryArtifact({
        sources,
        inputPath: nonExistentDump,
        authorIndexPath: authorIndexDir,
        outputPath,
        snapshotId: SNAPSHOT_ID,
      }),
      /ENOENT/,
    );

    const adapter2 = await createTargetedCanonicalAdapter({ artifactPath: outputPath });
    const candidatesAfter = await adapter2.getCandidates(sources[0]);
    assert.equal(candidatesAfter.length, 1, 'known-good artifact should be preserved after failed build');
    adapter2.close();

    const files = await fs.readdir(dir);
    assert.ok(!files.some(f => f.includes('.building-')), 'temporary building artifacts must be cleaned up on failure');
  });
});

test('19. internal pending tables/data cannot masquerade as a complete artifact', async () => {
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

    const outputPath = join(dir, 'targeted.sqlite');
    await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    const { DatabaseSync } = await import('node:sqlite');
    const validDb = new DatabaseSync(outputPath, { readOnly: true });
    const tableRows = validDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const tableNames = tableRows.map(r => r.name);
    validDb.close();

    assert.ok(!tableNames.includes('pending_editions'), 'pending_editions table must be dropped in finished artifact');
    assert.ok(!tableNames.includes('pending_author_keys'), 'pending_author_keys table must be dropped in finished artifact');

    // Create an unfinalized DB that still contains pending tables
    const incompleteDbPath = join(dir, 'incomplete.sqlite');
    const incompleteDb = new DatabaseSync(incompleteDbPath);
    incompleteDb.exec(`
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
      CREATE TABLE pending_editions (id INTEGER PRIMARY KEY);
      INSERT INTO metadata VALUES (1, 'bookish-open-library-targeted-candidates', 1, 'open-library-bulk', '${SNAPSHOT_ID}', 'sha256:0000000000000000000000000000000000000000000000000000000000000000', 0, 0, 0, 0, '2026-09-01T00:00:00.000Z');
    `);
    incompleteDb.close();

    await assert.rejects(
      () => readTargetedArtifactMetadata(incompleteDbPath),
      (err) => err instanceof CatalogContractError && err.code === 'invalid_targeted_artifact',
    );

    await assert.rejects(
      () => createTargetedCanonicalAdapter({ artifactPath: incompleteDbPath }),
      (err) => err instanceof CatalogContractError && (err.code === 'corrupt_targeted_artifact' || err.code === 'invalid_targeted_artifact'),
    );
  });
});

test('20. manifest mismatch protection still works', async () => {
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

test('21. --targeted pilot planner still succeeds', async () => {
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

    const actualStderr = result.stderr
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          trimmed.length > 0 &&
          !trimmed.includes('ExperimentalWarning: SQLite is an experimental feature') &&
          !trimmed.includes('--trace-warnings')
        );
      })
      .join('\n');
    assert.equal(actualStderr, '');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    assert.equal(plan.planVersion, 1);
    assert.equal(plan.summary.requestedWorks, 1);
    assert.equal(plan.summary.selected, 1);
    assert.equal(plan.entries[0].status, 'selected');
    assert.equal(plan.entries[0].selection.isbn13, '9780141439518');
  });
});

test('22. --index pilot planner still succeeds unchanged', async () => {
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

test('23. no network access is required and CLI tool executes completely offline', async () => {
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
    assert.equal(parsed.statistics.distinctAuthorKeysNeeded, 1);
    assert.equal(parsed.statistics.authorKeysResolved, 1);
  });
});

test('24. pending edition finalization does not require one .all() over all pending rows', async () => {
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

    const { DatabaseSync } = await import('node:sqlite');
    const dummyDb = new DatabaseSync(':memory:');
    const stmtProto = Object.getPrototypeOf(dummyDb.prepare('SELECT 1'));
    dummyDb.close();

    const originalAll = stmtProto.all;
    let pendingEditionsAllCalled = false;
    stmtProto.all = function (...args) {
      if (typeof this.sourceSQL === 'string' && this.sourceSQL.includes('FROM pending_editions')) {
        pendingEditionsAllCalled = true;
      }
      return originalAll.apply(this, args);
    };

    const outputPath = join(dir, 'targeted.sqlite');
    try {
      const result = await buildTargetedOpenLibraryArtifact({
        sources,
        inputPath: dumpPath,
        authorIndexPath: authorIndexDir,
        outputPath,
        snapshotId: SNAPSHOT_ID,
      });
      assert.equal(result.statistics.matchedEditions, 1);
      assert.equal(pendingEditionsAllCalled, false, 'pending_editions must not be queried via .all()');
    } finally {
      stmtProto.all = originalAll;
    }
  });
});

test('25. candidate validation does not require one .all() over all candidates', async () => {
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

    const outputPath = join(dir, 'targeted.sqlite');
    await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
    });

    const { DatabaseSync } = await import('node:sqlite');
    const dummyDb = new DatabaseSync(':memory:');
    const stmtProto = Object.getPrototypeOf(dummyDb.prepare('SELECT 1'));
    dummyDb.close();

    const originalAll = stmtProto.all;
    let candidatesAllCalled = false;
    stmtProto.all = function (...args) {
      if (typeof this.sourceSQL === 'string' && this.sourceSQL.includes('FROM candidates')) {
        candidatesAllCalled = true;
      }
      return originalAll.apply(this, args);
    };

    try {
      await validateBuiltTargetedArtifact(outputPath);
      assert.equal(candidatesAllCalled, false, 'candidates must not be validated via .all()');
    } finally {
      stmtProto.all = originalAll;
    }
  });
});

test('26. missing required author shard fails closed and preserves known-good artifact', async () => {
  await withTempDir(async ({ dir }) => {
    const authorKey = '/authors/OL1A';
    const shard = shardFor(authorKey);
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: authorKey, name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, dumpLine({
      key: '/books/OL100M',
      title: 'Pride and Prejudice',
      isbn13: '9780141439518',
      authors: [{ key: authorKey }],
    }));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
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

    const requiredShardPath = join(authorIndexDir, 'authors', shardName(shard));
    await fs.rm(requiredShardPath, { force: true });

    await assert.rejects(
      () => buildTargetedOpenLibraryArtifact({
        sources,
        inputPath: dumpPath,
        authorIndexPath: authorIndexDir,
        outputPath,
        snapshotId: SNAPSHOT_ID,
      }),
      (err) => err instanceof CatalogContractError && err.code === 'missing_author_shard',
    );

    const adapter2 = await createTargetedCanonicalAdapter({ artifactPath: outputPath });
    const candidatesAfter = await adapter2.getCandidates(sources[0]);
    assert.equal(candidatesAfter.length, 1, 'known-good artifact should be preserved after failed build');
    adapter2.close();
  });
});

test('27. progress fires based on rows scanned even if the triggering row is irrelevant', async () => {
  await withTempDir(async ({ dir }) => {
    const authorIndexDir = await createAuthorIndex(dir, [
      { key: '/authors/OL1A', name: 'Jane Austen' },
    ]);

    const dumpPath = join(dir, 'editions.txt');
    await fs.writeFile(dumpPath, [
      dumpLine({ key: '/books/OLIRR1M', title: 'Irrelevant 1', isbn13: '9780000000001', authors: [{ key: '/authors/OLOTHER' }] }),
      dumpLine({ key: '/books/OLIRR2M', title: 'Irrelevant 2', isbn13: '9780000000002', authors: [{ key: '/authors/OLOTHER' }] }),
      dumpLine({ key: '/books/OLIRR3M', title: 'Irrelevant 3', isbn13: '9780000000003', authors: [{ key: '/authors/OLOTHER' }] }),
      dumpLine({ key: '/books/OLIRR4M', title: 'Irrelevant 4', isbn13: '9780000000004', authors: [{ key: '/authors/OLOTHER' }] }),
    ].join(''));

    const sources = [
      { key: 'pride-and-prejudice', title: 'Pride and Prejudice', author: 'Jane Austen' },
    ];

    const progressCalls = [];
    const outputPath = join(dir, 'targeted.sqlite');
    const result = await buildTargetedOpenLibraryArtifact({
      sources,
      inputPath: dumpPath,
      authorIndexPath: authorIndexDir,
      outputPath,
      snapshotId: SNAPSHOT_ID,
      progressInterval: 2,
      onProgress: (stats) => {
        progressCalls.push({
          rowsScanned: stats.rowsScanned,
          pendingEditions: stats.pendingEditions,
        });
      },
    });

    assert.equal(result.statistics.rowsScanned, 4);
    assert.equal(result.statistics.pendingEditions, 0);
    assert.deepEqual(progressCalls, [
      { rowsScanned: 2, pendingEditions: 0 },
      { rowsScanned: 4, pendingEditions: 0 },
    ]);
  });
});

test('28. CLI progress with --json sends progress to stderr and preserves parseable stdout JSON', async () => {
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
      '--progress-interval', '1',
      '--json',
    ]);

    assert.ok(result.stderr.includes('[progress] rows scanned: 1'), 'stderr should contain coarse progress output');
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.statistics.matchedEditions, 1);
    assert.equal(parsed.statistics.rowsScanned, 1);
    assert.equal(parsed.statistics.canonicalCandidates, 1);
  });
});
