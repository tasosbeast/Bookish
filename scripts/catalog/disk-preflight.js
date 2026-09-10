import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_BUILD_AMPLIFICATION = 8;
export const DEFAULT_MINIMUM_SAFETY_RESERVE_BYTES = 10 * 1024 ** 3;
export const DEFAULT_SAFETY_RESERVE_RATIO = 0.25;

function validByteCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function validPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

export function calculateDiskPreflight({
  freeBytes,
  inputBytes,
  amplification = DEFAULT_BUILD_AMPLIFICATION,
  safetyReserveBytes = null,
  safetyReserveRatio = DEFAULT_SAFETY_RESERVE_RATIO,
  minimumSafetyReserveBytes = DEFAULT_MINIMUM_SAFETY_RESERVE_BYTES,
}) {
  freeBytes = validByteCount(freeBytes, 'freeBytes');
  inputBytes = validByteCount(inputBytes, 'inputBytes');
  amplification = validPositiveNumber(amplification, 'amplification');
  safetyReserveRatio = validPositiveNumber(safetyReserveRatio, 'safetyReserveRatio');
  minimumSafetyReserveBytes = validByteCount(minimumSafetyReserveBytes, 'minimumSafetyReserveBytes');
  if (safetyReserveBytes !== null) safetyReserveBytes = validByteCount(safetyReserveBytes, 'safetyReserveBytes');

  const estimatedPeakTemporaryBytes = Math.ceil(inputBytes * amplification);
  if (!Number.isSafeInteger(estimatedPeakTemporaryBytes)) throw new RangeError('estimatedPeakTemporaryBytes exceeds supported byte precision');
  const reserve = safetyReserveBytes ?? Math.max(minimumSafetyReserveBytes, Math.ceil(estimatedPeakTemporaryBytes * safetyReserveRatio));
  if (!Number.isSafeInteger(reserve)) throw new RangeError('safetyReserveBytes exceeds supported byte precision');
  const requiredBytes = estimatedPeakTemporaryBytes + reserve;
  if (!Number.isSafeInteger(requiredBytes)) throw new RangeError('requiredBytes exceeds supported byte precision');
  return {
    freeBytes,
    inputBytes,
    amplification,
    estimatedPeakTemporaryBytes,
    safetyReserveBytes: reserve,
    requiredBytes,
    availableAfterBuildBytes: freeBytes - requiredBytes,
    status: freeBytes >= requiredBytes ? 'pass' : 'insufficient_space',
  };
}

export async function preflightDiskCapacity({
  directory,
  inputPath,
  amplification,
  safetyReserveBytes,
  safetyReserveRatio,
  minimumSafetyReserveBytes,
  filesystem = fs,
}) {
  const targetDirectory = resolve(directory);
  const input = resolve(inputPath);
  const [filesystemStats, inputStats] = await Promise.all([
    filesystem.statfs(targetDirectory, { bigint: true }),
    filesystem.stat(input),
  ]);
  if (!inputStats.isFile()) throw new TypeError('inputPath must identify a file');
  const free = filesystemStats.bavail * filesystemStats.bsize;
  if (free > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Filesystem free space exceeds supported byte precision');
  const result = calculateDiskPreflight({
    freeBytes: Number(free),
    inputBytes: inputStats.size,
    amplification,
    safetyReserveBytes,
    safetyReserveRatio,
    minimumSafetyReserveBytes,
  });
  return { directory: targetDirectory, inputPath: input, ...result };
}
