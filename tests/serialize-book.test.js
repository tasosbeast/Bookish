import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeBook } from '../src/services/books.js';

test('serializeBook omits openLibraryWorkKey from the output', () => {
  const serialized = serializeBook({
    id: 'book-1',
    title: 'Example Book',
    author: 'Example Author',
    isbn: '9780000000000',
    openLibraryWorkKey: '/works/OL1W',
    publicationYear: 2026,
    publicationDate: null,
    averageRating: null,
    bookGenres: [],
  });

  assert.equal(Object.hasOwn(serialized, 'openLibraryWorkKey'), false);
  assert.equal(serialized.isbn, '9780000000000');
  assert.equal(serialized.title, 'Example Book');
});
