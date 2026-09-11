import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

test('PATCH /api/auth/me profile editing flow', { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  let userId;
  t.after(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const signupBody = { username: `user_${tag}`, email: `${tag}@example.com`, password: 'correct horse battery staple' };
  const authRes = await request(app)
    .post('/api/auth/signup')
    .set('X-Bookish-CSRF', '1')
    .send(signupBody)
    .expect(201);

  userId = authRes.body.user.id;
  const token = authRes.body.accessToken;

  const patch = body => request(app).patch('/api/auth/me').auth(token, { type: 'bearer' }).send(body);

  // 1. unauthenticated PATCH returns 401
  await request(app).patch('/api/auth/me').send({ bio: 'Hello' }).expect(401);

  // 2. authenticated user can update bio
  const bioRes = await patch({ bio: '  Love reading sci-fi and fantasy.  ' }).expect(200);
  assert.equal(bioRes.body.user.bio, 'Love reading sci-fi and fantasy.');
  assert.equal(bioRes.body.user.passwordHash, undefined);
  assert.deepEqual(Object.keys(bioRes.body.user).sort(), ['bio', 'email', 'id', 'profilePicture', 'username']);

  // 3. authenticated user can update profilePicture
  const picRes = await patch({ profilePicture: '  https://example.com/avatar.png  ' }).expect(200);
  assert.equal(picRes.body.user.profilePicture, 'https://example.com/avatar.png');
  assert.equal(picRes.body.user.bio, 'Love reading sci-fi and fantasy.');

  // 4. clearing either value stores null
  const clearRes = await patch({ bio: '   ', profilePicture: '' }).expect(200);
  assert.equal(clearRes.body.user.bio, null);
  assert.equal(clearRes.body.user.profilePicture, null);

  // 5. invalid/non-http(s) profilePicture URL returns 400
  for (const badUrl of ['javascript:alert(1)', 'data:image/png;base64,123', 'file:///etc/passwd', 'not-a-url', 'ftp://example.com/pic.png']) {
    await patch({ profilePicture: badUrl }).expect(400);
  }

  // 6. oversized bio returns 400
  await patch({ bio: 'a'.repeat(501) }).expect(400);

  // 7. unknown body fields return 400
  await patch({ bio: 'Valid', unknownField: true }).expect(400);

  // 8. empty body returns 400
  await patch({}).expect(400);

  // 9. response contains only safe user fields
  const finalMe = await request(app).get('/api/auth/me').auth(token, { type: 'bearer' }).expect(200);
  assert.equal(finalMe.body.user.bio, null);
  assert.equal(finalMe.body.user.profilePicture, null);
  assert.equal(finalMe.body.user.passwordHash, undefined);
});
