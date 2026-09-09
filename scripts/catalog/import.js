import { serializable } from '../../src/lib/transaction.js';
import {
  CATALOG_RESOLVER_VERSION,
  CatalogContractError,
  validateResolvedArtifact,
} from './contracts.js';

const CONTROLLED_GENRE_SLUGS = new Set([
  'fantasy', 'science-fiction', 'mystery', 'romance', 'history', 'biography',
  'science', 'philosophy', 'poetry', 'children', 'fiction',
]);

function isOpenLibraryCover(value) {
  try { return new URL(value).hostname === 'covers.openlibrary.org'; }
  catch { return false; }
}

function isGoogleBooksCover(value) {
  try { return ['books.google.com', 'books.googleusercontent.com', 'lh3.googleusercontent.com'].includes(new URL(value).hostname); }
  catch { return false; }
}

export function validateImportArtifact(value) {
  const artifact = validateResolvedArtifact(value);
  if (artifact.resolverVersion !== CATALOG_RESOLVER_VERSION
    || artifact.entries.some(entry => entry.resolverVersion !== CATALOG_RESOLVER_VERSION)) {
    throw new CatalogContractError('stale_artifact', `Catalog artifact must use resolver version ${CATALOG_RESOLVER_VERSION}`);
  }
  const unsupported = artifact.entries
    .filter(entry => entry.status === 'resolved')
    .flatMap(entry => entry.metadata.genres)
    .find(genre => !CONTROLLED_GENRE_SLUGS.has(genre.slug));
  if (unsupported) throw new CatalogContractError('unsupported_genre', `Unsupported catalog genre ${unsupported.slug}`);
  return artifact;
}

function importFields(metadata, existing) {
  const fields = { title: metadata.title, author: metadata.author };
  for (const key of ['publicationYear', 'description', 'coverImageUrl']) {
    const value = metadata[key];
    if (value === null) continue;
    if (key === 'coverImageUrl' && isGoogleBooksCover(value) && isOpenLibraryCover(existing?.coverImageUrl)) continue;
    fields[key] = value;
  }
  return fields;
}

async function inspectBook(db, metadata) {
  const existing = await db.book.findUnique({
    where: { isbn: metadata.isbn },
    include: { bookGenres: { include: { genre: true } } },
  });
  const fields = importFields(metadata, existing);
  const changes = existing
    ? Object.fromEntries(Object.entries(fields).filter(([key, value]) => existing[key] !== value))
    : fields;
  const existingSlugs = new Set(existing?.bookGenres.map(row => row.genre.slug) ?? []);
  const additions = metadata.genres.filter(genre => !existingSlugs.has(genre.slug));
  const outcome = !existing ? 'created' : Object.keys(changes).length || additions.length ? 'updated' : 'unchanged';
  return { existing, fields, changes, additions, outcome };
}

async function applyBook(db, metadata) {
  return serializable(db, async tx => {
    const inspected = await inspectBook(tx, metadata);
    if (inspected.outcome === 'unchanged') return inspected.outcome;
    const book = inspected.existing
      ? await tx.book.update({ where: { id: inspected.existing.id }, data: inspected.changes })
      : await tx.book.create({ data: { isbn: metadata.isbn, ...inspected.fields } });
    for (const item of inspected.additions) {
      const genre = await tx.genre.upsert({ where: { slug: item.slug }, create: item, update: {} });
      await tx.bookGenre.upsert({
        where: { bookId_genreId: { bookId: book.id, genreId: genre.id } },
        create: { bookId: book.id, genreId: genre.id },
        update: {},
      });
    }
    return inspected.outcome;
  });
}

export async function importResolvedCatalog(db, artifactValue, { apply, report = () => {} } = {}) {
  if (typeof apply !== 'boolean') throw new TypeError('apply must be true or false');
  const artifact = validateImportArtifact(artifactValue);
  const resolved = artifact.entries.filter(entry => entry.status === 'resolved');
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: artifact.entries.length - resolved.length,
    failed: 0,
    resolved: resolved.length,
  };
  for (const entry of resolved) {
    try {
      const outcome = apply ? await applyBook(db, entry.metadata) : (await inspectBook(db, entry.metadata)).outcome;
      summary[outcome]++;
    } catch (error) {
      summary.failed++;
      report(`${entry.key}: failed (${error?.message ?? String(error)})`);
    }
  }
  return summary;
}
