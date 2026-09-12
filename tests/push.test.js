import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pushSubscriptionSchema,
  deletePushSubscriptionSchema,
  pushSubscriptionStatusSchema,
} from '../src/validators/index.js';
import { sendFriendRequestPush } from '../src/services/pushService.js';
import { prisma } from '../src/lib/prisma.js';

test('Push validation: pushSubscriptionSchema validates endpoint and keys', () => {
  const valid = {
    body: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/sample-token',
      keys: {
        p256dh: 'BNc3fHZZsampleKey',
        auth: 'authSecretSample',
      },
    },
  };
  const parsed = pushSubscriptionSchema.parse(valid);
  assert.equal(parsed.body.endpoint, valid.body.endpoint);
  assert.equal(parsed.body.keys.p256dh, valid.body.keys.p256dh);

  // Rejects invalid endpoint URL
  assert.throws(() => pushSubscriptionSchema.parse({
    body: {
      endpoint: 'not-a-url',
      keys: { p256dh: 'key', auth: 'auth' },
    },
  }));

  // Rejects missing keys
  assert.throws(() => pushSubscriptionSchema.parse({
    body: {
      endpoint: 'https://example.com/endpoint',
    },
  }));
});

test('Push validation: deletePushSubscriptionSchema accepts endpoint in body or query', () => {
  // Body variant
  const bodyParsed = deletePushSubscriptionSchema.parse({
    body: { endpoint: 'https://example.com/endpoint' },
    query: {},
  });
  assert.equal(bodyParsed.body.endpoint, 'https://example.com/endpoint');

  // Query variant
  const queryParsed = deletePushSubscriptionSchema.parse({
    body: {},
    query: { endpoint: 'https://example.com/endpoint' },
  });
  assert.equal(queryParsed.query.endpoint, 'https://example.com/endpoint');

  // Rejects when endpoint is missing entirely
  assert.throws(() => deletePushSubscriptionSchema.parse({
    body: {},
    query: {},
  }));
});

test('Push validation: pushSubscriptionStatusSchema validates endpoint', () => {
  const valid = {
    body: { endpoint: 'https://example.com/endpoint' },
  };
  const parsed = pushSubscriptionStatusSchema.parse(valid);
  assert.equal(parsed.body.endpoint, 'https://example.com/endpoint');

  assert.throws(() => pushSubscriptionStatusSchema.parse({
    body: { endpoint: 'invalid-url' },
  }));

  assert.throws(() => pushSubscriptionStatusSchema.parse({
    body: {},
  }));
});

test('sendFriendRequestPush unit tests: best-effort delivery and cleanup', async () => {
  // 1. Swallows errors and does not throw even if prisma fails
  const origFindMany = prisma.pushSubscription.findMany;
  prisma.pushSubscription.findMany = async () => {
    throw new Error('Database connection lost');
  };
  try {
    await assert.doesNotReject(async () => {
      await sendFriendRequestPush('Alice', 'target-user-id', 'friendship-1');
    });
  } finally {
    prisma.pushSubscription.findMany = origFindMany;
  }

  // 2. Calls mock sender with expected payload
  const targetId = 'target-user-123';
  const sentPushes = [];
  const mockSender = {
    sendNotification: async (subscription, payload) => {
      sentPushes.push({ subscription, payload: JSON.parse(payload) });
    },
  };

  prisma.pushSubscription.findMany = async ({ where }) => {
    assert.equal(where.userId, targetId);
    return [
      { id: 'sub-1', endpoint: 'https://push1.example.com', p256dh: 'key1', auth: 'auth1' },
      { id: 'sub-2', endpoint: 'https://push2.example.com', p256dh: 'key2', auth: 'auth2' },
    ];
  };

  try {
    await sendFriendRequestPush('Alice', targetId, 'f-999', mockSender);
    assert.equal(sentPushes.length, 2);
    assert.equal(sentPushes[0].payload.title, 'Bookish');
    assert.equal(sentPushes[0].payload.body, 'Alice sent you a friend request');
    assert.equal(sentPushes[0].payload.url, '/friends?tab=requests');
    assert.equal(sentPushes[0].payload.tag, 'friend-request-f-999');
  } finally {
    prisma.pushSubscription.findMany = origFindMany;
  }

  // 3. Removes stale subscription when sender returns 410 or 404
  const deletedEndpoints = [];
  const origDeleteMany = prisma.pushSubscription.deleteMany;
  prisma.pushSubscription.deleteMany = async ({ where }) => {
    deletedEndpoints.push(where.endpoint);
    return { count: 1 };
  };

  prisma.pushSubscription.findMany = async () => [
    { id: 'sub-gone', endpoint: 'https://push-gone.example.com', p256dh: 'key', auth: 'auth' },
    { id: 'sub-error', endpoint: 'https://push-error.example.com', p256dh: 'key', auth: 'auth' },
  ];

  const failingSender = {
    sendNotification: async sub => {
      if (sub.endpoint.includes('gone')) {
        const error = new Error('Subscription expired');
        error.statusCode = 410;
        throw error;
      }
      if (sub.endpoint.includes('error')) {
        const error = new Error('Push gateway 500');
        error.statusCode = 500;
        throw error;
      }
    },
  };

  try {
    await sendFriendRequestPush('Alice', targetId, 'f-999', failingSender);
    assert.deepEqual(deletedEndpoints, ['https://push-gone.example.com'], 'Cleans up only 410 expired subscriptions');
  } finally {
    prisma.pushSubscription.findMany = origFindMany;
    prisma.pushSubscription.deleteMany = origDeleteMany;
  }
});
