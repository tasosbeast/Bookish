import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../scripts/catalog/atomic-write.js';

async function temporaryDirectory() {
  return fs.mkdtemp(join(tmpdir(), 'bookish-atomic-write-'));
}

test('writeFileAtomic leaves the previous file unchanged when validate rejects serialized content', async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, 'artifact.json');
  const original = '{"status":"good"}\n';
  await fs.writeFile(path, original, 'utf8');

  await assert.rejects(
    () => writeFileAtomic(path, '{"status":"bad"}\n', {
      validate: () => {
        throw new Error('validation failed');
      },
    }),
    /validation failed/,
  );

  assert.equal(await fs.readFile(path, 'utf8'), original);
});
