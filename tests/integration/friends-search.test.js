import '../setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { digest, signTokens } from '../../src/services/tokens.js';

test('PostgreSQL: reader search ranks usernames and returns relationship state',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 }, async t => {
    const tag = randomUUID().replaceAll('-', '').slice(0, 8);
    const users = [];
    const friendships = [];

    t.after(async () => {
      if (friendships.length) await prisma.friendship.deleteMany({ where: { id: { in: friendships } } });
      if (users.length) {
        await prisma.refreshSession.deleteMany({ where: { userId: { in: users.map(user => user.id) } } });
        await prisma.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
      }
      await prisma.$disconnect();
    });

    async function createUser(username, extra = {}) {
      const user = await prisma.user.create({ data: {
        username,
        email: `${username}@example.com`,
        passwordHash: 'friends-search-test-password-hash',
        ...extra,
      } });
      users.push(user);
      return user;
    }
    async function authenticate(user) {
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 86400000);
      const { accessToken } = signTokens(user.id, sessionId, expiresAt);
      await prisma.refreshSession.create({ data: { id: sessionId, userId: user.id, expiresAt, tokenHash: digest(`search-${sessionId}`) } });
      return accessToken;
    }
    const prefix = `seek${tag}`;
    const current = await createUser(`${prefix}self`);
    const exact = await createUser(prefix, { bio: 'Exact reader' });
    const alpha = await createUser(`${prefix}alpha`);
    const friend = await createUser(`${prefix}friend`);
    const outgoing = await createUser(`${prefix}outgoing`);
    const incoming = await createUser(`${prefix}incoming`);
    const contains = await createUser(`book${prefix}`);
    const token = await authenticate(current);
    const auth = path => request(app).get(path).auth(token, { type: 'bearer' });
    const createFriendship = async (target, requestedById, status) => {
      const [userAId, userBId] = current.id < target.id ? [current.id, target.id] : [target.id, current.id];
      const friendship = await prisma.friendship.create({ data: {
        userAId, userBId, requestedById, status, ...(status === 'accepted' && { acceptedAt: new Date() }),
      } });
      friendships.push(friendship.id);
      return friendship;
    };
    const accepted = await createFriendship(friend, current.id, 'accepted');
    const outgoingRequest = await createFriendship(outgoing, current.id, 'pending');
    const incomingRequest = await createFriendship(incoming, incoming.id, 'pending');

    await request(app).get('/api/friends/search').expect(401);
    await auth('/api/friends/search').expect(400);
    await auth('/api/friends/search?q=x').expect(400);
    await auth(`/api/friends/search?q=${prefix}&limit=21`).expect(400);

    const response = await auth(`/api/friends/search?q=${prefix.toUpperCase()}&limit=20`).expect(200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.data[0].user.id, exact.id, 'exact match ranks first');
    assert.equal(response.body.data.at(-1).user.id, contains.id, 'contains match ranks after prefixes');
    assert.ok(!response.body.data.some(item => item.user.id === current.id), 'the authenticated user is excluded');
    assert.deepEqual(response.body.data.slice(1, -1).map(item => item.user.username), [
      `${prefix}alpha`, `${prefix}friend`, `${prefix}incoming`, `${prefix}outgoing`,
    ], 'prefix matches are ordered by username');
    const byId = new Map(response.body.data.map(item => [item.user.id, item.relationship]));
    assert.deepEqual(byId.get(alpha.id), { status: 'none' });
    assert.deepEqual(byId.get(friend.id), { status: 'accepted', friendshipId: accepted.id });
    assert.deepEqual(byId.get(outgoing.id), { status: 'pending', direction: 'outgoing', requestId: outgoingRequest.id });
    assert.deepEqual(byId.get(incoming.id), { status: 'pending', direction: 'incoming', requestId: incomingRequest.id });
    assert.equal(response.body.data[0].user.email, undefined);
    assert.equal(response.body.data[0].user.passwordHash, undefined);

    const limited = await auth(`/api/friends/search?q=${prefix}&limit=2`).expect(200);
    assert.deepEqual(limited.body.data.map(item => item.user.id), [exact.id, alpha.id]);
  });
