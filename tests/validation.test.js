import test from 'node:test';
import assert from 'node:assert/strict';
import { signupSchema, shelfSchema, booksSchema, shelvesQuerySchema, maxAllowedFinishedOn, updateProfileSchema } from '../src/validators/index.js';
import { env, parseEnv } from '../src/config/env.js';
import { DEFAULT_AVATAR_HOSTS, isAllowedAvatarUrl } from '../src/lib/avatarUrl.js';

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

test('avatar host allowlist defaults to Gravatar and Google user content', () => {
  const source = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://bookish:password@db.example.com:5432/bookish',
    JWT_ACCESS_SECRET: 'access-secret-'.repeat(5),
    JWT_REFRESH_SECRET: 'refresh-secret-'.repeat(5),
    CLIENT_ORIGIN: 'https://app.example.com',
  };
  assert.deepEqual(parseEnv(source).AVATAR_ALLOWED_HOSTS, ['gravatar.com', 'googleusercontent.com']);
  assert.deepEqual(parseEnv({ ...source, AVATAR_ALLOWED_HOSTS: '   ' }).AVATAR_ALLOWED_HOSTS, DEFAULT_AVATAR_HOSTS);
  assert.deepEqual(
    parseEnv({ ...source, AVATAR_ALLOWED_HOSTS: ' CDN.Example.com, lh3.googleusercontent.com ' }).AVATAR_ALLOWED_HOSTS,
    ['cdn.example.com', 'lh3.googleusercontent.com'],
  );
  for (const invalid of ['com', '*.gravatar.com', 'https://gravatar.com', 'gravatar.com/avatar', '-bad.com']) {
    assert.throws(() => parseEnv({ ...source, AVATAR_ALLOWED_HOSTS: invalid }), /AVATAR_ALLOWED_HOSTS/);
  }
});

test('profile pictures accept only https URLs on allowlisted hosts', () => {
  const accepted = [
    'https://www.gravatar.com/avatar/00000000000000000000000000000000',
    'https://secure.gravatar.com/avatar/abc?s=200&d=identicon',
    'https://gravatar.com/avatar/abc?default=mp',
    'https://s.gravatar.com/avatar/abc?d=retro',
    'https://lh3.googleusercontent.com/a-/photo',
    'https://lh4.googleusercontent.com/a/photo=s96-c',
    'HTTPS://WWW.GRAVATAR.COM/avatar/abc',
  ];
  for (const profilePicture of accepted) {
    assert.equal(updateProfileSchema.parse({ body: { profilePicture } }).body.profilePicture, profilePicture.trim(), profilePicture);
  }
  assert.equal(updateProfileSchema.parse({ body: { profilePicture: '' } }).body.profilePicture, null);
  assert.equal(updateProfileSchema.parse({ body: { profilePicture: '   ' } }).body.profilePicture, null);
  assert.equal(updateProfileSchema.parse({ body: { profilePicture: null } }).body.profilePicture, null);

  const rejected = [
    'http://www.gravatar.com/avatar/abc',
    'http://lh3.googleusercontent.com/a/photo',
    'https://example.com/avatar.png',
    'https://images.example/profile.jpg',
    'https://notgravatar.com/avatar/abc',
    'https://gravatar.com.evil.example/avatar/abc',
    'https://www.gravatar.com.evil.example/avatar/abc',
    'https://lh3.googleusercontent.com.evil.example/a',
    'https://user:pass@www.gravatar.com/avatar/abc',
    'https://evil.example@www.gravatar.com/avatar/abc',
    'https://www.gravatar.com:444/avatar/abc',
    'https://127.0.0.1/avatar.png',
    'javascript:alert(1)',
    'data:image/png;base64,aaaa',
    'file:///etc/passwd',
    'ftp://gravatar.com/avatar/abc',
    'not-a-url',
    'https://www.gravatar.com/avatar/abc?d=https://evil.example/pixel.png',
    'https://www.gravatar.com/avatar/abc?default=//evil.example/pixel.png',
    'https://www.gravatar.com/avatar/abc?d=identicon&d=https://evil.example/pixel.png',
    `https://www.gravatar.com/${'a'.repeat(2100)}`,
  ];
  for (const profilePicture of rejected) {
    assert.equal(updateProfileSchema.safeParse({ body: { profilePicture } }).success, false, profilePicture);
  }

  assert.equal(isAllowedAvatarUrl('https://cdn.example/a.png', ['cdn.example']), true);
  assert.equal(isAllowedAvatarUrl('https://images.cdn.example/a.png', ['cdn.example']), true);
  assert.equal(isAllowedAvatarUrl('https://www.gravatar.com/avatar/abc', ['cdn.example']), false);
  assert.equal(isAllowedAvatarUrl('https://notcdn.example/a.png', ['cdn.example']), false);

  const original = env.AVATAR_ALLOWED_HOSTS;
  env.AVATAR_ALLOWED_HOSTS = ['cdn.example'];
  try {
    assert.equal(updateProfileSchema.parse({ body: { profilePicture: 'https://cdn.example/a.png' } }).body.profilePicture, 'https://cdn.example/a.png');
    assert.equal(updateProfileSchema.safeParse({ body: { profilePicture: 'https://www.gravatar.com/avatar/abc' } }).success, false);
    assert.equal(updateProfileSchema.safeParse({ body: { profilePicture: 'http://cdn.example/a.png' } }).success, false);
  } finally {
    env.AVATAR_ALLOWED_HOSTS = original;
  }
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

test('shelf validation validates finishedOn format, leap years, future dates, and status requirements', () => {
  const bookId = '11111111-1111-4111-8111-111111111111';
  const today = new Date().toISOString().slice(0, 10);

  // Valid finishedOn with status read or alone
  assert.equal(shelfSchema.parse({ body: { bookId, status: 'read', finishedOn: '2024-02-29' } }).body.finishedOn, '2024-02-29');
  assert.equal(shelfSchema.parse({ body: { bookId, finishedOn: today } }).body.finishedOn, today);

  // Future finishedOn rejected
  const futureYear = new Date().getUTCFullYear() + 1;
  assert.equal(shelfSchema.safeParse({ body: { bookId, status: 'read', finishedOn: `${futureYear}-01-01` } }).success, false);

  // Invalid calendar dates rejected (e.g. Feb 30, non-leap year Feb 29, month 13, month 00)
  for (const invalidDate of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-32']) {
    assert.equal(shelfSchema.safeParse({ body: { bookId, status: 'read', finishedOn: invalidDate } }).success, false, `Expected ${invalidDate} to fail`);
  }

  // Timestamps and non-YYYY-MM-DD formats rejected
  for (const malformed of ['2026-09-05T00:00:00Z', '2026/09/05', '09-05-2026', '2026-9-5']) {
    assert.equal(shelfSchema.safeParse({ body: { bookId, status: 'read', finishedOn: malformed } }).success, false, `Expected ${malformed} to fail`);
  }

  // Non-read status + finishedOn rejected
  for (const nonRead of ['want_to_read', 'currently_reading']) {
    assert.equal(shelfSchema.safeParse({ body: { bookId, status: nonRead, finishedOn: '2024-02-29' } }).success, false);
  }
});

test('maxAllowedFinishedOn and shelf validation handles midnight/local-vs-UTC edge across timezones', () => {
  const bookId = '11111111-1111-4111-8111-111111111111';

  // 1. Edge before UTC midnight (e.g. 23:30 UTC):
  // Users east of UTC (e.g. UTC+1 to UTC+14) have already crossed midnight into 2026-09-15.
  const utcBeforeMidnight = new Date('2026-09-14T23:30:00.000Z');
  assert.equal(maxAllowedFinishedOn(utcBeforeMidnight), '2026-09-15');

  // 2. Edge after UTC midnight (e.g. 00:30 UTC):
  const utcAfterMidnight = new Date('2026-09-15T00:30:00.000Z');
  assert.equal(maxAllowedFinishedOn(utcAfterMidnight), '2026-09-16');

  // 3. Month boundaries: Sep 30 23:55 UTC -> Oct 01
  assert.equal(maxAllowedFinishedOn(new Date('2026-09-30T23:55:00.000Z')), '2026-10-01');

  // 4. Leap year boundaries: Feb 28 23:55 UTC in leap year -> Feb 29
  assert.equal(maxAllowedFinishedOn(new Date('2024-02-28T23:55:00.000Z')), '2024-02-29');
  assert.equal(maxAllowedFinishedOn(new Date('2024-02-29T23:55:00.000Z')), '2024-03-01');

  // 5. Year boundary: Dec 31 23:55 UTC -> Jan 01
  assert.equal(maxAllowedFinishedOn(new Date('2026-12-31T23:55:00.000Z')), '2027-01-01');

  // 6. Live validation accepts today and tomorrow (UTC+1 day), rejects 2 days ahead
  const now = new Date();
  const utcToday = now.toISOString().slice(0, 10);
  const tomorrow = maxAllowedFinishedOn(now);
  const twoDaysAhead = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2)).toISOString().slice(0, 10);

  assert.equal(shelfSchema.safeParse({ body: { bookId, status: 'read', finishedOn: utcToday } }).success, true);
  assert.equal(shelfSchema.safeParse({ body: { bookId, status: 'read', finishedOn: tomorrow } }).success, true);
  assert.equal(shelfSchema.safeParse({ body: { bookId, status: 'read', finishedOn: twoDaysAhead } }).success, false);
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
