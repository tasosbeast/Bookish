import './setup.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { signTokens, verifyToken } from '../src/services/tokens.js';
import { bookFilter } from '../src/services/books.js';

after(() => prisma.$disconnect());
test('health, unknown routes, malformed JSON and invalid pagination', async () => {
  await request(app).get('/health').expect(200);
  await request(app).get('/missing').expect(404);
  await request(app).get('/api/books?limit=101').expect(400);
  await request(app).get('/api/books/not-a-uuid').expect(400);
  const response = await request(app).post('/api/auth/signup').set('Content-Type', 'application/json').send('{').expect(400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});
test('auth endpoints enforce CSRF and validation before database access', async () => {
  await request(app).post('/api/auth/login').send({}).expect(403);
  await request(app).post('/api/auth/login').set('X-Bookish-CSRF', '1').set('Origin', 'https://evil.example').send({}).expect(403);
  await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({}).expect(400);
  const response = await request(app).post('/api/auth/refresh').set('X-Bookish-CSRF', '1').expect(401);
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('protected routes reject missing and malformed bearer tokens', async () => {
  await request(app).post('/api/user-books').send({}).expect(401);
  await request(app).post('/api/reviews').set('Authorization', 'Bearer invalid').send({}).expect(401);
});
test('profile and shelf reads require authentication; public books reject supplied invalid credentials', async () => {
  for (const path of ['/api/auth/me', '/api/user-books']) {
    await request(app).get(path).expect(401);
  }
  for (const path of ['/api/auth/me', '/api/user-books', '/api/books/', `/api/books/${randomUUID()}`]) {
    for (const header of ['', 'Basic invalid', 'Bearer invalid']) {
      await request(app).get(path).set('Authorization', header).expect(401);
    }
  }
});
test('JWT verification rejects wrong token type, tampering, expiration and algorithm', () => {
  const tokens = signTokens(randomUUID(), randomUUID(), new Date(Date.now() + 60000));
  assert.equal(verifyToken(tokens.accessToken, 'access').type, 'access');
  assert.equal(verifyToken(tokens.refreshToken, 'refresh').type, 'refresh');
  assert.throws(() => verifyToken(tokens.refreshToken, 'access'), { status: 401 });
  assert.throws(() => verifyToken(tokens.accessToken + 'broken', 'access'), { status: 401 });
  const claims = { sub: randomUUID(), sid: randomUUID(), type: 'access', jti: randomUUID() };
  for (const options of [{ algorithm: 'HS256', expiresIn: -1 }, { algorithm: 'HS384', expiresIn: 60 }]) {
    const token = jwt.sign(claims, process.env.JWT_ACCESS_SECRET, { ...options, issuer: 'bookish-api', audience: 'bookish-client' });
    assert.throws(() => verifyToken(token, 'access'), { status: 401 });
  }
});
test('search escapes PostgreSQL LIKE metacharacters', () => {
  assert.equal(bookFilter({ q: '50%_\\' }).OR[0].title.contains, '50\\%\\_\\\\');
});
