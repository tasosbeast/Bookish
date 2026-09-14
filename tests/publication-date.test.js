import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeBook,
  serializePublicationDate,
  checkPublicationYearConsistency,
} from '../src/services/books.js';

test('Publication Date Foundation: serializePublicationDate and serializeBook', async () => {
  // 1. null / undefined / empty serializes as null
  assert.equal(serializePublicationDate(null), null);
  assert.equal(serializePublicationDate(undefined), null);
  assert.equal(serializePublicationDate(''), null);

  // 2. Date object serializes to YYYY-MM-DD
  const dateObj = new Date('2026-09-22T00:00:00.000Z');
  assert.equal(serializePublicationDate(dateObj), '2026-09-22');

  // 3. String date serializes to YYYY-MM-DD
  assert.equal(serializePublicationDate('2026-09-22'), '2026-09-22');
  assert.equal(serializePublicationDate('2026-09-22T14:30:00.000Z'), '2026-09-22');

  // 4. Timezone safety: Date object created from UTC preserves calendar day
  const year = 2026, month = 8, day = 22; // Sept 22, 2026
  const utcDate = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  assert.equal(serializePublicationDate(utcDate), '2026-09-22');

  // 5. serializeBook with publicationDate = null
  const bookWithoutDate = {
    id: 'book-1',
    title: 'Classic Book',
    author: 'Classic Author',
    publicationYear: 1984,
    publicationDate: null,
    averageRating: '4.25',
    bookGenres: [{ genre: { id: 'g1', name: 'Sci-Fi', slug: 'sci-fi' } }],
  };
  const serialized1 = serializeBook(bookWithoutDate);
  assert.equal(serialized1.publicationDate, null);
  assert.equal(serialized1.publicationYear, 1984);
  assert.equal(serialized1.averageRating, 4.25);
  assert.deepEqual(serialized1.genres, [{ id: 'g1', name: 'Sci-Fi', slug: 'sci-fi' }]);

  // 6. serializeBook with publicationDate = Date object
  const bookWithDate = {
    id: 'book-2',
    title: 'New Release',
    author: 'Modern Author',
    publicationYear: 2026,
    publicationDate: new Date('2026-09-22T00:00:00.000Z'),
    averageRating: null,
    bookGenres: [],
  };
  const serialized2 = serializeBook(bookWithDate);
  assert.equal(serialized2.publicationDate, '2026-09-22');
  assert.equal(serialized2.publicationYear, 2026);
  assert.equal(serialized2.averageRating, null);
  assert.deepEqual(serialized2.genres, []);

  // 7. serializeBook with omitted/undefined publicationDate defaults to null
  const bookOmittedDate = {
    id: 'book-3',
    title: 'Legacy Book',
    author: 'Legacy Author',
    publicationYear: 2001,
    averageRating: 3.5,
    bookGenres: [],
  };
  const serialized3 = serializeBook(bookOmittedDate);
  assert.equal(serialized3.publicationDate, null);
  assert.equal(serialized3.publicationYear, 2001);

  // 8. Invariant helper: checkPublicationYearConsistency
  // Valid when year matches
  assert.equal(checkPublicationYearConsistency('2026-09-22', 2026), true);
  assert.equal(checkPublicationYearConsistency(new Date('2026-09-22T00:00:00.000Z'), 2026), true);

  // Invalid when year differs
  assert.equal(checkPublicationYearConsistency('2026-09-22', 2025), false);
  assert.equal(checkPublicationYearConsistency(new Date('2026-09-22T00:00:00.000Z'), 2025), false);

  // Valid when either or both are null/undefined
  assert.equal(checkPublicationYearConsistency(null, 2026), true);
  assert.equal(checkPublicationYearConsistency(undefined, 2026), true);
  assert.equal(checkPublicationYearConsistency('2026-09-22', null), true);
  assert.equal(checkPublicationYearConsistency('2026-09-22', undefined), true);
  assert.equal(checkPublicationYearConsistency(null, null), true);
});
