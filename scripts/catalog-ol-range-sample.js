import { resolve } from 'node:path';
import { downloadOpenLibraryRangeSample } from './catalog/open-library-sample.js';

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseArguments(args) {
  const options = { url: null, outputPath: null, byteLimit: null, rowLimit: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (['--url', '--output', '--bytes', '--rows'].includes(argument)) {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--url') options.url = value;
      if (argument === '--output') options.outputPath = resolve(value);
      if (argument === '--bytes') options.byteLimit = parsePositiveInteger(value, argument);
      if (argument === '--rows') options.rowLimit = parsePositiveInteger(value, argument);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.url || !options.outputPath || !options.byteLimit || !options.rowLimit) throw new Error('--url, --output, --bytes and --rows are required');
  return options;
}

try {
  console.log(JSON.stringify(await downloadOpenLibraryRangeSample(parseArguments(process.argv.slice(2)))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
