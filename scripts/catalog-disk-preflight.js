import { resolve } from 'node:path';
import { preflightDiskCapacity } from './catalog/disk-preflight.js';

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function byteCount(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parseArguments(args) {
  const options = { directory: process.cwd(), inputPath: null, amplification: undefined, safetyReserveBytes: undefined, json: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--json') options.json = true;
    else if (['--directory', '--input', '--amplification', '--reserve-bytes'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--directory') options.directory = resolve(value);
      if (argument === '--input') options.inputPath = resolve(value);
      if (argument === '--amplification') options.amplification = positiveNumber(value, argument);
      if (argument === '--reserve-bytes') options.safetyReserveBytes = byteCount(value, argument);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.inputPath) throw new Error('--input is required');
  return options;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await preflightDiskCapacity(options);
  if (options.json) console.log(JSON.stringify(result));
  else console.log([
    `directory: ${result.directory}`,
    `input: ${result.inputPath}`,
    `free: ${formatBytes(result.freeBytes)}`,
    `input size: ${formatBytes(result.inputBytes)}`,
    `amplification: ${result.amplification}x`,
    `estimated peak temporary build space: ${formatBytes(result.estimatedPeakTemporaryBytes)}`,
    `safety reserve: ${formatBytes(result.safetyReserveBytes)}`,
    `required free space: ${formatBytes(result.requiredBytes)}`,
    `status: ${result.status.toUpperCase()}`,
  ].join('\n'));
  if (result.status !== 'pass') process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
