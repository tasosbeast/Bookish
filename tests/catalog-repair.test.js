import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightLaunchRepair,
  repairLaunchCatalog,
  RepairCatalogError,
} from '../scripts/catalog/repair-launch.js';
import { LAUNCH_REPAIR_MANIFEST } from '../scripts/catalog/repair-manifest.js';
import { coverImageUrl } from '../scripts/catalog/csv-import.js';

function createMockDb(initialBooks = []) {
  const books = new Map(initialBooks.map(b => [b.id, structuredClone(b)]));

  const select = (row, fields) => {
    if (!fields) return structuredClone(row);
    return Object.fromEntries(
      Object.keys(fields)
        .filter(k => fields[k])
        .map(k => [k, row[k]])
    );
  };

  const db = {
    book: {
      findMany: async ({ where, select: fields } = {}) => {
        let list = [...books.values()];
        if (where?.isbn?.in) {
          const inSet = new Set(where.isbn.in);
          list = list.filter(b => inSet.has(b.isbn));
        }
        if (where?.id?.in) {
          const inSet = new Set(where.id.in);
          list = list.filter(b => inSet.has(b.id));
        }
        return list.map(b => select(b, fields));
      },
      update: async ({ where, data }) => {
        const book = books.get(where.id);
        if (!book) throw new Error(`Record to update not found: ${where.id}`);
        // Check ISBN unique constraint simulation
        if (data.isbn && data.isbn !== book.isbn) {
          for (const other of books.values()) {
            if (other.id !== book.id && other.isbn === data.isbn) {
              const err = new Error('Unique constraint failed on the fields: (isbn)');
              err.code = 'P2002';
              throw err;
            }
          }
        }
        Object.assign(book, data);
        return select(book);
      },
    },
    $transaction: async fn => {
      // Deep snapshot for rollback simulation
      const snapshot = new Map([...books.entries()].map(([k, v]) => [k, structuredClone(v)]));
      try {
        const tx = {
          book: {
            findMany: db.book.findMany,
            update: db.book.update,
          },
        };
        return await fn(tx);
      } catch (err) {
        books.clear();
        for (const [k, v] of snapshot.entries()) {
          books.set(k, v);
        }
        throw err;
      }
    },
    _books: books,
  };

  return db;
}

function build27LaunchFixtures() {
  return LAUNCH_REPAIR_MANIFEST.map((entry, idx) => ({
    id: `book-launch-${idx + 1}`,
    title: entry.expectedCurrentTitle,
    author: entry.expectedCurrentAuthor,
    isbn: entry.oldIsbn,
    coverImageUrl: `https://covers.openlibrary.org/b/isbn/${entry.oldIsbn}-L.jpg?default=false`,
    description: `Original description ${idx + 1}`,
    publicationYear: 2000 + idx,
    averageRating: '4.50',
    ratingsCount: 10 + idx,
  }));
}

test('1. dry-run makes zero writes', async () => {
  const fixtures = build27LaunchFixtures();
  const db = createMockDb(fixtures);

  const result = await repairLaunchCatalog(db, { apply: false });

  assert.equal(result.applied, false);
  assert.equal(result.summary.repairEntries, 27);
  assert.equal(result.summary.found, 27);
  assert.equal(result.summary.alreadyRepaired, 0);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.identityConflicts, 0);
  assert.equal(result.summary.isbnCollisions, 0);
  assert.equal(result.summary.readyToRepair, 27);
  assert.equal(result.summary.updated, 0);

  // Assert database state completely untouched
  for (const f of fixtures) {
    const b = db._books.get(f.id);
    assert.equal(b.title, f.title);
    assert.equal(b.author, f.author);
    assert.equal(b.isbn, f.isbn);
  }
});

test('2. clean repair updates metadata in-place and preserves Book.id', async () => {
  const fixtures = build27LaunchFixtures();
  const db = createMockDb(fixtures);

  const result = await repairLaunchCatalog(db, { apply: true });

  assert.equal(result.applied, true);
  assert.equal(result.summary.repairEntries, 27);
  assert.equal(result.summary.found, 27);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.identityConflicts, 0);
  assert.equal(result.summary.isbnCollisions, 0);
  assert.equal(result.summary.readyToRepair, 27);
  assert.equal(result.summary.updated, 27);

  for (let idx = 0; idx < LAUNCH_REPAIR_MANIFEST.length; idx++) {
    const entry = LAUNCH_REPAIR_MANIFEST[idx];
    const expectedId = `book-launch-${idx + 1}`;
    const book = db._books.get(expectedId);

    assert.ok(book, `Book ${expectedId} must exist`);
    assert.equal(book.id, expectedId, 'Book.id must be preserved');
    assert.equal(book.title, entry.desiredTitle);
    assert.equal(book.author, entry.desiredAuthor);
    assert.equal(book.isbn, entry.desiredIsbn);
    assert.equal(book.description, `Original description ${idx + 1}`);
    assert.equal(book.publicationYear, 2000 + idx);
    assert.equal(book.averageRating, '4.50');
    assert.equal(book.ratingsCount, 10 + idx);

    if (entry.desiredIsbn !== entry.oldIsbn) {
      assert.equal(book.coverImageUrl, coverImageUrl(entry.desiredIsbn));
    } else {
      assert.equal(book.coverImageUrl, `https://covers.openlibrary.org/b/isbn/${entry.oldIsbn}-L.jpg?default=false`);
    }
  }
});

test('3. second dry-run after repair identifies rows as already repaired (idempotent)', async () => {
  const fixtures = build27LaunchFixtures();
  const db = createMockDb(fixtures);

  // First apply
  await repairLaunchCatalog(db, { apply: true });

  // Second run: dry run
  const resultDry = await repairLaunchCatalog(db, { apply: false });
  assert.equal(resultDry.summary.repairEntries, 27);
  assert.equal(resultDry.summary.found, 27);
  assert.equal(resultDry.summary.alreadyRepaired, 27);
  assert.equal(resultDry.summary.missing, 0);
  assert.equal(resultDry.summary.identityConflicts, 0);
  assert.equal(resultDry.summary.isbnCollisions, 0);
  assert.equal(resultDry.summary.readyToRepair, 0);
  assert.equal(resultDry.summary.updated, 0);

  // Third run: apply again
  const resultApply = await repairLaunchCatalog(db, { apply: true });
  assert.equal(resultApply.summary.alreadyRepaired, 27);
  assert.equal(resultApply.summary.readyToRepair, 0);
  assert.equal(resultApply.summary.updated, 0);
});

test('4. target ISBN collision blocks ALL writes and throws RepairCatalogError', async () => {
  const fixtures = build27LaunchFixtures();
  // Add a colliding book with the desired ISBN of Thinking, Fast and Slow (9780374533557)
  fixtures.push({
    id: 'colliding-book',
    title: 'Unrelated Book',
    author: 'Some Author',
    isbn: '9780374533557',
    coverImageUrl: null,
  });

  const db = createMockDb(fixtures);

  await assert.rejects(
    async () => repairLaunchCatalog(db, { apply: true }),
    err => {
      assert.ok(err instanceof RepairCatalogError);
      assert.equal(err.code, 'preflight_failed');
      assert.equal(err.details.summary.isbnCollisions, 1);
      assert.equal(err.details.details.isbnCollisionErrors.length, 1);
      assert.equal(err.details.details.isbnCollisionErrors[0].desiredIsbn, '9780374533557');
      return true;
    }
  );

  // Verify zero writes occurred
  assert.equal(db._books.get('book-launch-3').isbn, '9780385676533');
});

test('5. missing old Book blocks ALL writes and throws RepairCatalogError', async () => {
  const fixtures = build27LaunchFixtures();
  // Remove one book (e.g. index 5, Eragon)
  const remaining = fixtures.filter(f => f.id !== 'book-launch-6');
  const db = createMockDb(remaining);

  await assert.rejects(
    async () => repairLaunchCatalog(db, { apply: true }),
    err => {
      assert.ok(err instanceof RepairCatalogError);
      assert.equal(err.code, 'preflight_failed');
      assert.equal(err.details.summary.missing, 1);
      assert.equal(err.details.details.missingErrors.length, 1);
      assert.equal(err.details.details.missingErrors[0].isbn, '9780375826702');
      return true;
    }
  );

  // Verify zero writes occurred
  assert.equal(db._books.get('book-launch-1').isbn, '9781400034710');
});

test('6. unexpected title/author blocks ALL writes and throws RepairCatalogError', async () => {
  const fixtures = build27LaunchFixtures();
  // Corrupt the title of Matilda
  fixtures[3].title = 'Completely Wrong Title';
  const db = createMockDb(fixtures);

  await assert.rejects(
    async () => repairLaunchCatalog(db, { apply: true }),
    err => {
      assert.ok(err instanceof RepairCatalogError);
      assert.equal(err.code, 'preflight_failed');
      assert.equal(err.details.summary.identityConflicts, 1);
      assert.equal(err.details.details.identityConflictErrors.length, 1);
      return true;
    }
  );

  // Verify zero writes occurred
  assert.equal(db._books.get('book-launch-1').isbn, '9781400034710');
});

test('7. same-ISBN title corrections work and do not alter coverImageUrl', async () => {
  // Isolate the 5 same-ISBN entries
  const sameIsbnManifest = LAUNCH_REPAIR_MANIFEST.filter(e => e.oldIsbn === e.desiredIsbn);
  assert.equal(sameIsbnManifest.length, 4); // Harry Potter, Painted Man, Corelli, Big Country

  const fixtures = sameIsbnManifest.map((entry, idx) => ({
    id: `same-isbn-book-${idx + 1}`,
    title: entry.expectedCurrentTitle,
    author: entry.expectedCurrentAuthor,
    isbn: entry.oldIsbn,
    coverImageUrl: 'https://example.com/custom-cover.jpg',
  }));

  const db = createMockDb(fixtures);

  const result = await repairLaunchCatalog(db, { apply: true, manifest: sameIsbnManifest });
  assert.equal(result.summary.updated, 4);

  for (let idx = 0; idx < sameIsbnManifest.length; idx++) {
    const entry = sameIsbnManifest[idx];
    const b = db._books.get(`same-isbn-book-${idx + 1}`);
    assert.equal(b.title, entry.desiredTitle);
    assert.equal(b.author, entry.desiredAuthor);
    assert.equal(b.isbn, entry.desiredIsbn);
    assert.equal(b.coverImageUrl, 'https://example.com/custom-cover.jpg', 'Cover URL must remain unchanged');
  }
});

test('8. transaction rollback when mid-update error occurs', async () => {
  const fixtures = build27LaunchFixtures();
  const db = createMockDb(fixtures);

  // Patch update to fail on 10th book
  let updateCount = 0;
  const originalUpdate = db.book.update;
  db.book.update = async args => {
    updateCount++;
    if (updateCount === 10) {
      throw new Error('Simulated network failure during batch update');
    }
    return originalUpdate(args);
  };

  await assert.rejects(
    async () => repairLaunchCatalog(db, { apply: true }),
    /Simulated network failure/
  );

  // Verify all books rolled back to original state
  for (const f of fixtures) {
    const b = db._books.get(f.id);
    assert.equal(b.title, f.title);
    assert.equal(b.isbn, f.isbn);
  }
});

test('9. old ISBN missing + desired ISBN missing + exactly one normalized match under third ISBN => ALTERNATE_IDENTITY_MATCH', async () => {
  const manifest = [
    {
      oldIsbn: '9780143110439',
      expectedCurrentTitle: 'Thinking, Fast and Slow',
      expectedCurrentAuthor: 'Daniel Kahneman',
      desiredTitle: 'Thinking, Fast and Slow',
      desiredAuthor: 'Daniel Kahneman',
      desiredIsbn: '9780374533557',
    },
  ];

  // In DB, book exists under third ISBN: 9780385676533
  const db = createMockDb([
    {
      id: 'book-alt-1',
      title: 'Thinking, Fast and Slow',
      author: 'Daniel Kahneman',
      isbn: '9780385676533',
    },
  ]);

  const result = await preflightLaunchRepair(db, manifest);
  assert.equal(result.summary.alternateIdentityMatches, 1);
  assert.equal(result.summary.genuinelyMissing, 0);
  assert.equal(result.summary.ambiguousIdentityMatches, 0);
  assert.equal(result.summary.readyToRepair, 0);

  assert.equal(result.details.alternateIdentityMatches.length, 1);
  const match = result.details.alternateIdentityMatches[0];
  assert.equal(match.bookId, 'book-alt-1');
  assert.equal(match.title, 'Thinking, Fast and Slow');
  assert.equal(match.author, 'Daniel Kahneman');
  assert.equal(match.currentIsbn, '9780385676533');
  assert.equal(match.manifestOldIsbn, '9780143110439');
  assert.equal(match.desiredIsbn, '9780374533557');
});

test('10. no ISBN match and no identity match => genuinely missing', async () => {
  const manifest = [
    {
      oldIsbn: '9780143110439',
      expectedCurrentTitle: 'Thinking, Fast and Slow',
      expectedCurrentAuthor: 'Daniel Kahneman',
      desiredTitle: 'Thinking, Fast and Slow',
      desiredAuthor: 'Daniel Kahneman',
      desiredIsbn: '9780374533557',
    },
  ];

  // In DB, only unrelated book exists
  const db = createMockDb([
    {
      id: 'book-unrelated-1',
      title: 'Dune',
      author: 'Frank Herbert',
      isbn: '9780441172719',
    },
  ]);

  const result = await preflightLaunchRepair(db, manifest);
  assert.equal(result.summary.genuinelyMissing, 1);
  assert.equal(result.summary.missing, 1);
  assert.equal(result.summary.alternateIdentityMatches, 0);
  assert.equal(result.summary.ambiguousIdentityMatches, 0);
  assert.equal(result.details.genuinelyMissingList.length, 1);
  assert.equal(result.details.genuinelyMissingList[0].isbn, '9780143110439');
});

test('11. multiple identity matches => ambiguous identity match', async () => {
  const manifest = [
    {
      oldIsbn: '9780140328721',
      expectedCurrentTitle: 'Matilda',
      expectedCurrentAuthor: 'Roald Dahl',
      desiredTitle: 'Matilda',
      desiredAuthor: 'Roald Dahl',
      desiredIsbn: '9780142410370',
    },
  ];

  // In DB, two books match the work under different third ISBNs
  const db = createMockDb([
    {
      id: 'book-matilda-1',
      title: 'Matilda',
      author: 'Roald Dahl',
      isbn: '9780613371896',
    },
    {
      id: 'book-matilda-2',
      title: 'Matilda (Puffin Books)',
      author: 'Roald Dahl',
      isbn: '9780141301068',
    },
  ]);

  const result = await preflightLaunchRepair(db, manifest);
  assert.equal(result.summary.ambiguousIdentityMatches, 1);
  assert.equal(result.summary.alternateIdentityMatches, 0);
  assert.equal(result.summary.genuinelyMissing, 0);
  assert.equal(result.summary.readyToRepair, 0);

  assert.equal(result.details.ambiguousIdentityMatches.length, 1);
  const amb = result.details.ambiguousIdentityMatches[0];
  assert.equal(amb.manifestOldIsbn, '9780140328721');
  assert.equal(amb.desiredIsbn, '9780142410370');
  assert.equal(amb.candidates.length, 2);
  const ids = amb.candidates.map(c => c.bookId).sort();
  assert.deepEqual(ids, ['book-matilda-1', 'book-matilda-2']);
});

test('12. alternate identity match blocks apply and throws RepairCatalogError', async () => {
  const manifest = [
    {
      oldIsbn: '9780143110439',
      expectedCurrentTitle: 'Thinking, Fast and Slow',
      expectedCurrentAuthor: 'Daniel Kahneman',
      desiredTitle: 'Thinking, Fast and Slow',
      desiredAuthor: 'Daniel Kahneman',
      desiredIsbn: '9780374533557',
    },
  ];

  const db = createMockDb([
    {
      id: 'book-alt-1',
      title: 'Thinking, Fast and Slow',
      author: 'Daniel Kahneman',
      isbn: '9780385676533',
    },
  ]);

  await assert.rejects(
    async () => repairLaunchCatalog(db, { apply: true, manifest }),
    err => {
      assert.ok(err instanceof RepairCatalogError);
      assert.equal(err.code, 'preflight_failed');
      assert.equal(err.details.summary.alternateIdentityMatches, 1);
      assert.equal(err.details.summary.updated, 0);
      return true;
    }
  );

  // Assert Book in DB is untouched
  const book = db._books.get('book-alt-1');
  assert.equal(book.isbn, '9780385676533');
});

test('13. dry-run performs zero writes when alternate identity matches are detected', async () => {
  const manifest = [
    {
      oldIsbn: '9780143110439',
      expectedCurrentTitle: 'Thinking, Fast and Slow',
      expectedCurrentAuthor: 'Daniel Kahneman',
      desiredTitle: 'Thinking, Fast and Slow',
      desiredAuthor: 'Daniel Kahneman',
      desiredIsbn: '9780374533557',
    },
  ];

  const db = createMockDb([
    {
      id: 'book-alt-1',
      title: 'Thinking, Fast and Slow',
      author: 'Daniel Kahneman',
      isbn: '9780385676533',
    },
  ]);

  const result = await repairLaunchCatalog(db, { apply: false, manifest });
  assert.equal(result.applied, false);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.alternateIdentityMatches, 1);
  assert.equal(result.summary.readyToRepair, 0);

  // Assert Book in DB is untouched
  const book = db._books.get('book-alt-1');
  assert.equal(book.isbn, '9780385676533');
  assert.equal(book.title, 'Thinking, Fast and Slow');
});

