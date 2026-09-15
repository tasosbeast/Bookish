import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalCanonicalAdapter } from './catalog/snapshot-index.js';
import { planCatalogPilot } from './catalog/pilot-planner.js';

function parseArguments(args) {
  const options = { source: null, index: null, output: null };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--source' || argument === '--index' || argument === '--output') {
      const value = args[++i];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = resolve(value);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  if (!options.source) throw new Error('--source is required');
  if (!options.index) throw new Error('--index is required');
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
  const adapter = await createLocalCanonicalAdapter({ indexPath: options.index });
  const plan = await planCatalogPilot({ sources, adapter });

  const formattedOutput = `${JSON.stringify(plan, null, 2)}\n`;

  if (options.output) {
    await writeFile(options.output, formattedOutput, 'utf8');
  } else {
    process.stdout.write(formattedOutput);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
