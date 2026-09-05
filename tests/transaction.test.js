import test from 'node:test';
import assert from 'node:assert/strict';
import { serializable } from '../src/lib/transaction.js';

test('retries serialization and concurrent insert failures as whole transactions', async () => {
  let calls = 0;
  const db = { $transaction: async (work, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    calls++;
    if (calls < 3) throw Object.assign(new Error(), { code: calls === 1 ? 'P2034' : 'P2002' });
    return work('transaction');
  } };
  assert.equal(await serializable(db, async tx => tx, { sleep: async () => {} }), 'transaction');
  assert.equal(calls, 3);
});
test('exhausted conflicts return retryable 503; business failures are not retried', async () => {
  await assert.rejects(serializable({ $transaction: async () => { throw Object.assign(new Error(), { code: 'P2034' }); } },
    () => {}, { attempts: 2, sleep: async () => {} }), { status: 503 });
  let calls = 0;
  const error = new Error('business failure');
  await assert.rejects(serializable({ $transaction: async () => { calls++; throw error; } }, () => {}), error);
  assert.equal(calls, 1);
});
