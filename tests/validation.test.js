import test from 'node:test';
import assert from 'node:assert/strict';
import { signupSchema, shelfSchema, booksSchema, shelvesQuerySchema } from '../src/validators/index.js';
import { parseEnv } from '../src/config/env.js';

test('production configuration requires an explicit HTTPS frontend origin', () => {
  const source = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://bookish:password@db.example.com:5432/bookish',
    JWT_ACCESS_SECRET: 'access-secret-'.repeat(5),
    JWT_REFRESH_SECRET: 'refresh-secret-'.repeat(5),
  };
  assert.throws(() => parseEnv(source), /CLIENT_ORIGIN is required/);
  assert.throws(() => parseEnv({ ...source, CLIENT_ORIGIN: 'http://app.example.com' }), /must use HTTPS/);
  assert.equal(parseEnv({ ...source, CLIENT_ORIGIN: 'https://app.example.com' }).CLIENT_ORIGIN, 'https://app.example.com');
});

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
  assert.equal(booksSchema.parse({ query: { author: ' Jane Austen ' } }).query.author, 'Jane Austen');
  for (const query of [{ page: 0 }, { limit: 101 }, { sort: 'passwordHash' }, { q: ['a', 'b'] }, { author: '' }]) {
    assert.equal(booksSchema.safeParse({ query }).success, false);
  }
});

test('shelf queries bound pagination, validate status and reject client-supplied identity', () => {
  assert.deepEqual(shelvesQuerySchema.parse({ query: {} }).query, { page: 1, limit: 20 });
  for (const status of ['want_to_read', 'currently_reading', 'read']) {
    assert.equal(shelvesQuerySchema.parse({ query: { status, page: '2', limit: '1' } }).query.status, status);
  }
  for (const query of [{ status: 'reading' }, { page: 10001 }, { limit: 0 }, { limit: 101 },
    { page: 1.5 }, { userId: 'another-user' }, { status: ['read', 'want_to_read'] }]) {
    assert.equal(shelvesQuerySchema.safeParse({ query }).success, false);
  }
});
