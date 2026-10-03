import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFileAtomic(path, content, { fsImpl = fs, platform = process.platform, mode = 0o600 } = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${path}.${process.pid}.${randomUUID()}.bak`;
  await fsImpl.mkdir(dirname(path), { recursive: true });
  let handle;
  let backupExists = false;
  try {
    handle = await fsImpl.open(temporary, 'w', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fsImpl.rename(temporary, path);
    } catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;

      try {
        await fsImpl.rename(path, backup);
        backupExists = true;
      } catch {
        throw error;
      }

      try {
        await fsImpl.rename(temporary, path);
      } catch (replacementError) {
        try {
          await fsImpl.rename(backup, path);
          backupExists = false;
        } catch (restoreError) {
          throw new AggregateError(
            [replacementError, restoreError],
            `Artifact replacement failed; the prior artifact remains recoverable at ${backup}`,
          );
        }
        throw replacementError;
      }

      try {
        await fsImpl.unlink(backup);
        backupExists = false;
      } catch { /* The new artifact is installed; a recoverable backup is safe. */ }
    }
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the original write error. */ }
    try { await fsImpl.unlink(temporary); } catch { /* A missing temporary file is safe. */ }
    if (backupExists) {
      try {
        await fsImpl.rename(backup, path);
        backupExists = false;
      } catch { /* Preserve the recoverable backup and the original write error. */ }
    }
    throw error;
  }
}

export async function writeArtifactAtomic(path, artifact, options = {}) {
  return writeFileAtomic(path, `${JSON.stringify(artifact, null, 2)}\n`, options);
}
