import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('GET /api/user-books search filtering with q parameter', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  let user1, user2, book1, book2, book3;

  t.after(async () => {
    if (book1) await prisma.book.delete({ where: { id: book1.id } });
    if (book2) await prisma.book.delete({ where: { id: book2.id } });
    if (book3) await prisma.book.delete({ where: { id: book3.id } });
    if (user1) await prisma.user.delete({ where: { id: user1.id } });
    if (user2) await prisma.user.delete({ where: { id: user2.id } });
    await prisma.$disconnect();
  });

  const auth = async (username, email) => {
    const res = await request(app).post('/api/auth/signup').set('X-Bookish-CSRF', '1').send({
      username, email, password: 'correct horse battery staple',
    }).expect(201);
    return res.body;
  };

  const u1Data = await auth(`user1_${tag}`, `user1_${tag}@example.com`);
  const u2Data = await auth(`user2_${tag}`, `user2_${tag}@example.com`);
  user1 = u1Data.user;
  user2 = u2Data.user;

  book1 = await prisma.book.create({ data: { title: `Dune Messiah ${tag}`, author: 'Frank Herbert' } });
  book2 = await prisma.book.create({ data: { title: `Foundation ${tag}`, author: 'Isaac Asimov' } });
  book3 = await prisma.book.create({ data: { title: `Foundation and Empire ${tag}`, author: 'Isaac Asimov' } });

  await request(app).post('/api/user-books').auth(u1Data.accessToken, { type: 'bearer' }).send({ bookId: book1.id, status: 'read' }).expect(200);
  await request(app).post('/api/user-books').auth(u1Data.accessToken, { type: 'bearer' }).send({ bookId: book2.id, status: 'want_to_read' }).expect(200);
  await request(app).post('/api/user-books').auth(u1Data.accessToken, { type: 'bearer' }).send({ bookId: book3.id, status: 'read' }).expect(200);

  await request(app).post('/api/user-books').auth(u2Data.accessToken, { type: 'bearer' }).send({ bookId: book1.id, status: 'read' }).expect(200);

  const getU1 = (query = '') => request(app).get(`/api/user-books${query}`).auth(u1Data.accessToken, { type: 'bearer' });
  const getU2 = (query = '') => request(app).get(`/api/user-books${query}`).auth(u2Data.accessToken, { type: 'bearer' });

  // 1. q matches title case-insensitively
  const res1 = await getU1('?q=DUNE').expect(200);
  assert.equal(res1.body.data.length, 1);
  assert.equal(res1.body.data[0].book.id, book1.id);
  assert.equal(res1.body.pagination.total, 1);

  // 2. q matches author case-insensitively
  const res2 = await getU1('?q=asimov').expect(200);
  assert.equal(res2.body.data.length, 2);
  assert.equal(res2.body.pagination.total, 2);

  // 3. q + status compose correctly
  const res3 = await getU1('?status=read&q=asimov').expect(200);
  assert.equal(res3.body.data.length, 1);
  assert.equal(res3.body.data[0].book.id, book3.id);
  assert.equal(res3.body.pagination.total, 1);

  // 4. Another user's matching books are never returned
  const res4 = await getU2('?q=asimov').expect(200);
  assert.equal(res4.body.data.length, 0);
  assert.equal(res4.body.pagination.total, 0);

  // 5. Invalid/oversized q returns 400
  await getU1(`?q=${'a'.repeat(201)}`).expect(400);

  // 6. Unknown parameter returns 400
  await getU1('?q=dune&unknownParam=1').expect(400);

  // 7. Existing no-q behavior remains unchanged
  const resDefault = await getU1('').expect(200);
  assert.equal(resDefault.body.data.length, 3);
  assert.equal(resDefault.body.pagination.total, 3);
});
