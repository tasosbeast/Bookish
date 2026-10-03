import { resolve } from 'node:path';
import {
  createReadOnlyPrismaClient,
  runCatalogDedupCheck,
} from './catalog/dedup-check.js';

function parseArguments(args) {
  const options = {
    input: null,
    output: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--input' || argument === '--output') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--input') options.input = resolve(value);
      else options.output = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument ${argument}`);
  }
  if (!options.input || !options.output) {
    throw new Error('--input and --output are required');
  }
  return options;
}

let db;
try {
  const options = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  db = createReadOnlyPrismaClient(databaseUrl);
  const { summary } = await runCatalogDedupCheck({
    db,
    inputPath: options.input,
    outputPath: options.output,
  });
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
