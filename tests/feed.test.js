import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encodeCursor, decodeCursor } from '../src/services/feed.js';
import { feedQuerySchema } from '../src/validators/index.js';

test('Feed unit: encodeCursor and decodeCursor handle valid inputs and roundtrips', () => {
  const id = randomUUID();
  const date = new Date('2026-09-15T12:34:56.789Z');
  const cursor = encodeCursor({ createdAt: date.toISOString(), id });

  assert.equal(typeof cursor, 'string');
  assert.ok(cursor.length > 0);

  const decoded = decodeCursor(cursor);
  assert.ok(decoded);
  assert.equal(decoded.id, id);
  assert.equal(decoded.createdAt.toISOString(), date.toISOString());
});

test('Feed unit: decodeCursor rejects malformed and invalid cursors cleanly', () => {
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(undefined), null);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('not-valid-base64-json!@#$%^'), null);

  // Valid base64 but not JSON
  const notJson = Buffer.from('hello world').toString('base64url');
  assert.equal(decodeCursor(notJson), null);

  // Missing id
  const missingId = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString() })).toString('base64url');
  assert.equal(decodeCursor(missingId), null);

  // Invalid UUID
  const invalidUuid = Buffer.from(JSON.stringify({ id: 'not-a-uuid', createdAt: new Date().toISOString() })).toString('base64url');
  assert.equal(decodeCursor(invalidUuid), null);

  // Missing createdAt
  const missingCreatedAt = Buffer.from(JSON.stringify({ id: randomUUID() })).toString('base64url');
  assert.equal(decodeCursor(missingCreatedAt), null);

  // Invalid date
  const invalidDate = Buffer.from(JSON.stringify({ id: randomUUID(), createdAt: 'not-a-date' })).toString('base64url');
  assert.equal(decodeCursor(invalidDate), null);
});

test('Feed validation: feedQuerySchema sets defaults and validates limit and cursor', () => {
  // Default limit
  const res1 = feedQuerySchema.parse({ query: {} });
  assert.equal(res1.query.limit, 20);
  assert.equal(res1.query.cursor, undefined);

  // Explicit valid limit and cursor
  const cursor = encodeCursor({ createdAt: new Date().toISOString(), id: randomUUID() });
  const res2 = feedQuerySchema.parse({ query: { limit: '10', cursor } });
  assert.equal(res2.query.limit, 10);
  assert.equal(res2.query.cursor, cursor);

  // Maximum limit 50
  const res3 = feedQuerySchema.parse({ query: { limit: '50' } });
  assert.equal(res3.query.limit, 50);

  // Limit < 1 fails
  assert.throws(() => feedQuerySchema.parse({ query: { limit: '0' } }), /too_small/);
  assert.throws(() => feedQuerySchema.parse({ query: { limit: '-5' } }), /too_small/);

  // Limit > 50 fails
  assert.throws(() => feedQuerySchema.parse({ query: { limit: '51' } }), /too_big/);

  // Non-integer limit fails
  assert.throws(() => feedQuerySchema.parse({ query: { limit: 'not-a-number' } }), /invalid_type|expected_number/);

  // Strict query: unknown parameters fail
  assert.throws(() => feedQuerySchema.parse({ query: { page: '1' } }), /unrecognized_keys/);
  assert.throws(() => feedQuerySchema.parse({ query: { extra: 'hello' } }), /unrecognized_keys/);
});
