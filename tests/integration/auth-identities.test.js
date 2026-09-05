import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import * as auth from '../../src/services/auth.js';

test('PostgreSQL: authentication uses literal case-insensitive identity equality',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const password = 'shared fixture password only';
    const ids = [];
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.$disconnect();
    });
    const post = (path, body) => request(app).post(`/api/auth/${path}`).set('X-Bookish-CSRF', '1').send(body);
    const register = async (username, email) => {
      const response = await post('signup', { username, email, password });
      // Track even unexpected successful writes so failed regressions leave no fixtures behind.
      if (response.body.user?.id) ids.push(response.body.user.id);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.user;
    };

    await t.test('login cannot authenticate a wildcard-shaped email as another account', async () => {
      await register(`login${tag}`, `login${tag}axb@example.com`);
      const response = await post('login', { email: `login${tag}a_b@example.com`, password });
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(response.body.accessToken, undefined);
      assert.equal(response.headers['set-cookie'], undefined);
    });

    await t.test('distinct underscore emails can register and each login returns its own user', async () => {
      const plain = await register(`plain${tag}`, `email${tag}axb@example.com`);
      const literal = await register(`literal${tag}`, `email${tag}a_b@example.com`);
      // Identical passwords make a wrong-identity match visible instead of masking it as a bad password.
      for (const user of [plain, literal]) {
        const response = await post('login', { email: ` ${user.email.toUpperCase()} `, password }).expect(200);
        assert.deepEqual(response.body.user, user);
        assert.equal(response.body.user.passwordHash, undefined);
      }
    });

    await t.test('a username underscore is literal during the signup uniqueness check', async () => {
      const plain = await register(`name${tag}axb`, `nameplain${tag}@example.com`);
      const literal = await register(`name${tag}a_b`, `nameliteral${tag}@example.com`);
      assert.notEqual(plain.id, literal.id);
    });

    await t.test('legacy mixed-case identities still log in and reject case-only duplicates', async () => {
      const user = await register(`legacy${tag}`, `legacy${tag}@example.com`);
      const stored = await prisma.user.update({ where: { id: user.id }, data: {
        username: user.username.toUpperCase(), email: user.email.toUpperCase(),
      } });
      const login = await post('login', { email: user.email, password }).expect(200);
      assert.equal(login.body.user.id, user.id);
      assert.equal(login.body.user.email, stored.email);
      await post('signup', { username: `different${tag}`, email: user.email, password }).expect(409);
      await post('signup', { username: user.username, email: `different${tag}@example.com`, password }).expect(409);
    });

    await t.test('service lookups treat percent and backslash literally; HTTP validation remains unchanged', async () => {
      for (const [index, character, plainSuffix] of [[0, '%', 'axb'], [1, '\\', 'ab']]) {
        const prefix = `symbol${tag}${index}`;
        const plain = await auth.signup({ username: `${prefix}plain`, email: `${prefix}${plainSuffix}@example.com`, password });
        ids.push(plain.user.id);
        const email = `${prefix}a${character}b@example.com`;
        await assert.rejects(auth.login({ email, password }), { status: 401, code: 'INVALID_CREDENTIALS' });
        const literal = await auth.signup({ username: `${prefix}literal`, email, password });
        ids.push(literal.user.id);
        assert.equal((await auth.login({ email, password })).user.id, literal.user.id);
        await post('login', { email, password }).expect(400);
      }
    });
  });
