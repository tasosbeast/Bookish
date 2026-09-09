import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveCatalog } from './catalog/resolve.js';
import { createGoogleBooksClient } from './catalog/providers/google-books.js';
import { createOpenLibraryClient } from './catalog/providers/open-library.js';

const defaults = {
  source: resolve('scripts/catalog-source.json'),
  artifact: resolve('scripts/catalog-resolved.json'),
};

function parseArguments(args) {
  const options = { ...defaults, retryFailed: false, retryReview: false, refresh: false, key: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--retry-failed') options.retryFailed = true;
    else if (argument === '--retry-review') options.retryReview = true;
    else if (argument === '--refresh') options.refresh = true;
    else if (argument === '--key' || argument === '--source' || argument === '--artifact') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      const option = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[option] = option === 'key' ? value : resolve(value);
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
  const sources = await readJson(options.source, true);
  const existingArtifact = await readJson(options.artifact, false);
  const { summary } = await resolveCatalog({
    sources,
    existingArtifact,
    providers: { openLibrary: createOpenLibraryClient(), googleBooks: createGoogleBooksClient() },
    retryFailed: options.retryFailed,
    retryReview: options.retryReview,
    refresh: options.refresh,
    key: options.key,
    checkpointPath: options.artifact,
  });
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
