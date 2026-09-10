import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip, constants as zlibConstants } from 'node:zlib';

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new TypeError('Open Library sample URL must use HTTPS');
  return url;
}

function rangeLength(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value ?? '');
  if (!match || match[1] !== '0') throw new Error('Source did not honor the requested byte range from zero');
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) throw new Error('Source returned an invalid Content-Range');
  return last - first + 1;
}

export async function downloadOpenLibraryRangeSample({ url, outputPath, byteLimit, rowLimit, fetchImpl = globalThis.fetch }) {
  url = httpsUrl(url);
  outputPath = resolve(outputPath);
  byteLimit = positiveInteger(byteLimit, 'byteLimit');
  rowLimit = positiveInteger(rowLimit, 'rowLimit');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const response = await fetchImpl(url, { headers: { Range: `bytes=0-${byteLimit - 1}` }, redirect: 'follow' });
  if (response.status !== 206) throw new Error(`Expected HTTP 206 for bounded sample, received ${response.status}`);
  const downloadedBytes = rangeLength(response.headers.get('content-range'));
  if (downloadedBytes > byteLimit) throw new Error('Source returned more bytes than the requested sample limit');
  if (!response.body) throw new Error('Source returned no response body');

  const temporaryPath = `${outputPath}.building-${process.pid}-${Date.now()}`;
  let rows = 0;
  try {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    const source = Readable.fromWeb(response.body);
    const input = url.pathname.endsWith('.gz') ? source.pipe(createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH })) : source;
    const lines = createInterface({ input, crlfDelay: Infinity });
    const output = createWriteStream(temporaryPath, { encoding: 'utf8', flags: 'wx' });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (!output.write(`${line}\n`)) await new Promise(resolveWrite => output.once('drain', resolveWrite));
        rows += 1;
        if (rows >= rowLimit) break;
      }
      await new Promise((resolveWrite, rejectWrite) => {
        output.once('error', rejectWrite);
        output.once('finish', resolveWrite);
        output.end();
      });
    } finally {
      lines.close();
      source.destroy();
      output.destroy();
    }
    if (!rows) throw new Error('The bounded range contained no complete dump rows');
    await fs.rename(temporaryPath, outputPath);
    return { url: url.toString(), outputPath, downloadedBytes, rows };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
