import { resolve } from 'node:path';
import { runCatalogBridge } from './catalog/bridge.js';

try {
  const options = { outputPath: resolve('scripts/catalog-cache/catalog-bridged.json'), limit: 500 };
  const flags = { '--report': 'reportPath', '--input': 'inputPath', '--editions': 'editionsPath', '--authors-index': 'authorsIndexPath', '--output': 'outputPath', '--limit': 'limit' };
  const args = process.argv.slice(2);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!Object.hasOwn(flags, flag) || seen.has(flag)) throw new Error(`Unknown or repeated argument ${flag}`);
    seen.add(flag);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--limit' && !/^\d+$/.test(value)) throw new Error('--limit must be an integer');
    options[flags[flag]] = flag === '--limit' ? Number(value) : resolve(value);
  }
  console.log(JSON.stringify(await runCatalogBridge(options)));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
