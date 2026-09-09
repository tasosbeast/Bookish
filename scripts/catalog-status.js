import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCatalogStatus, formatCatalogStatus, isCatalogStatusStrictFailure } from './catalog/status.js';

const defaults = {
  source: resolve('scripts/catalog-source.json'),
  artifact: resolve('scripts/catalog-resolved.json'),
};

function parseArguments(args) {
  const options = { ...defaults, strict: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--strict') options.strict = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--source' || argument === '--artifact') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = resolve(value);
    } else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

async function readJson(path, required) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw new Error(`Unable to read ${path}: ${error.message}`, { cause: error });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const status = createCatalogStatus({
    sources: await readJson(options.source, true),
    artifact: await readJson(options.artifact, false),
  });
  console.log(options.json ? JSON.stringify(status) : formatCatalogStatus(status));
  if (!status.valid || (options.strict && isCatalogStatusStrictFailure(status))) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
