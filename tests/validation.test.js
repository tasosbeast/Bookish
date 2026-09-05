import test from 'node:test';
import assert from 'node:assert/strict';
import { signupSchema, shelfSchema, booksSchema } from '../src/validators/index.js';

test('signup normalizes identity but preserves password and enforces bcrypt byte limit', () => {
  const body = { username: '  Reader_1 ', email: ' READER@example.com ', password: '  strong password  ' };
  const parsed = signupSchema.parse({ body }).body;
  assert.equal(parsed.username, 'reader_1');
  assert.equal(parsed.email, 'reader@example.com');
  assert.equal(parsed.password, body.password);
  assert.equal(signupSchema.safeParse({ body: { ...body, password: '😀'.repeat(19) } }).success, false);
  assert.equal(signupSchema.safeParse({ body: { ...body, role: 'admin' } }).success, false);
});
test('shelf validation distinguishes omitted rating and explicit null', () => {
  const bookId = '11111111-1111-4111-8111-111111111111';
  assert.equal(shelfSchema.parse({ body: { bookId, status: 'read' } }).body.userRating, undefined);
  assert.equal(shelfSchema.parse({ body: { bookId, userRating: null } }).body.userRating, null);
  for (const body of [{ bookId }, { bookId, userRating: 0 }, { bookId, userRating: 2.5 }, { bookId, status: 'reading' }]) {
    assert.equal(shelfSchema.safeParse({ body }).success, false);
  }
});
test('pagination is bounded and sort fields are allowlisted', () => {
  assert.deepEqual(booksSchema.parse({ query: {} }).query, { page: 1, limit: 20, sort: 'rating', order: 'desc' });
  for (const query of [{ page: 0 }, { limit: 101 }, { sort: 'passwordHash' }, { q: ['a', 'b'] }]) {
    assert.equal(booksSchema.safeParse({ query }).success, false);
  }
});
