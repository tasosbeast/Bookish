import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalCanonicalAdapter } from './catalog/snapshot-index.js';
import { createTargetedCanonicalAdapter } from './catalog/open-library-targeted.js';
import { manifestFingerprint } from './catalog/contracts.js';
import { planCatalogPilot } from './catalog/pilot-planner.js';

function parseArguments(args) {
  const options = { source: null, index: null, targeted: null, output: null };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--source' || argument === '--index' || argument === '--targeted' || argument === '--output') {
      const value = args[++i];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = resolve(value);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!options.source) throw new Error('--source is required');
  if (options.index && options.targeted) throw new Error('Exactly one of --index or --targeted must be supplied');
  if (!options.index && !options.targeted) throw new Error('Either --index or --targeted is required');
  return options;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read source file at ${path}: ${error.message}`, { cause: error });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const sources = await readJson(options.source);
  let adapter;
  if (options.index) {
    adapter = await createLocalCanonicalAdapter({ indexPath: options.index });
  } else {
    const expectedFingerprint = manifestFingerprint(sources);
    adapter = await createTargetedCanonicalAdapter({
      artifactPath: options.targeted,
      expectedManifestFingerprint: expectedFingerprint,
    });
  }

  try {
    const plan = await planCatalogPilot({ sources, adapter });

    const formattedOutput = `${JSON.stringify(plan, null, 2)}\n`;

    if (options.output) {
      await writeFile(options.output, formattedOutput, 'utf8');
    } else {
      process.stdout.write(formattedOutput);
    }
  } finally {
    if (adapter && typeof adapter.close === 'function') {
      adapter.close();
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
