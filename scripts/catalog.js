import { setTimeout as delay } from 'node:timers/promises';
import { serializable } from '../src/lib/transaction.js';

export function isbn13(value) {
  if (typeof value !== 'string') throw new Error('Invalid ISBN-13');
  const isbn = value.replace(/[ -]/g, '');
  if (!/^97[89]\d{10}$/.test(isbn) || [...isbn].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0) % 10) throw new Error('Invalid ISBN-13');
  return isbn;
}
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const REQUEST_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 250;
const vocabulary = {
  Fantasy: ['fantasy', 'fantasy fiction'],
  'Science Fiction': ['science fiction'],
  Mystery: ['mystery', 'detective and mystery stories', 'mystery fiction'],
  Romance: ['romance', 'love stories', 'romance fiction'],
  History: ['history', 'world history'],
  Biography: ['biography', 'autobiography', 'memoir', 'autobiographies'],
  Science: ['science', 'popular science', 'physics'],
  Philosophy: ['philosophy'],
  Poetry: ['poetry'],
  Children: ['children', "children's fiction", 'juvenile fiction'],
  Fiction: ['fiction', 'literary fiction'],
};
export function mapGenres(subjects) {
  const normalized = new Set((Array.isArray(subjects) ? subjects : []).filter(v => typeof v === 'string').map(v => v.trim().toLowerCase().replace(/\s+/g, ' ')));
  return Object.entries(vocabulary).filter(([, aliases]) => aliases.some(a => normalized.has(a)))
    .map(([name]) => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }));
}
export function mapEdition(isbn, edition, authors, work = {}) {
  isbn = isbn13(isbn);
  if (!edition || typeof edition !== 'object' || !Array.isArray(edition.isbn_13) || !edition.isbn_13.includes(isbn)) throw new Error('Edition ISBN mismatch');
  const title = text(edition.title);
  if (!title || !authors.length || authors.some(a => !text(a))) return null;
  const date = text(edition.publish_date) ?? '';
  // Accept a single explicit year, not ranges, approximate dates or work first-publication dates.
  const years = date.match(/\b\d{4}\b/g) ?? [];
  const year = years.length === 1 && !/[?\[\]]|circa|about|before|after|\bc\./i.test(date) ? Number(years[0]) : null;
  const cover = (Array.isArray(edition.covers) ? edition.covers : []).find(id => Number.isSafeInteger(id) && id > 0);
  const description = value => text(typeof value === 'object' && value ? value.value : value);
  return { isbn, title, author: [...new Set(authors.map(a => a.trim()))].join(', '),
    publicationYear: year >= 1000 && year <= new Date().getFullYear() + 1 ? year : null,
    description: description(edition.description) ?? description(work.description),
    coverImageUrl: cover ? `https://covers.openlibrary.org/b/id/${cover}-L.jpg?default=false` : null,
    genres: mapGenres([...(Array.isArray(edition.subjects) ? edition.subjects : []), ...(Array.isArray(work.subjects) ? work.subjects : [])]) };
}
function googleCoverUrl(imageLinks) {
  for (const size of ['extraLarge', 'large', 'medium', 'small', 'thumbnail', 'smallThumbnail']) {
    try {
      const url = new URL(imageLinks?.[size]);
      if (!['books.google.com', 'books.googleusercontent.com', 'lh3.googleusercontent.com'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || /(?:placeholder|no[-_ ]?cover|not[-_ ]?found|blank)/i.test(url.pathname)) continue;
      url.protocol = 'https:';
      return url.toString();
    } catch { /* Try the next advertised image size. */ }
  }
  return null;
}
function hasIsbn13(item, isbn) {
  return Array.isArray(item?.volumeInfo?.industryIdentifiers) && item.volumeInfo.industryIdentifiers.some(identifier => {
    if (identifier?.type !== 'ISBN_13') return false;
    try { return isbn13(identifier.identifier) === isbn; } catch { return false; }
  });
}
function isOpenLibraryCover(value) {
  try { return new URL(value).hostname === 'covers.openlibrary.org'; } catch { return false; }
}
function isGoogleBooksCover(value) {
  try { return ['books.google.com', 'books.googleusercontent.com', 'lh3.googleusercontent.com'].includes(new URL(value).hostname); } catch { return false; }
}
export function openLibrary({ fetchImpl = fetch, sleep = delay, timeout = 10000 } = {}) {
  let first = true;
  async function request(url) {
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
      if (!first) await sleep(1100);
      first = false;
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': 'BookishCatalogImporter/1.0 (explicit local catalog import)', Accept: 'application/json' },
          signal: AbortSignal.timeout(timeout), redirect: 'manual',
        });
        if (attempt === REQUEST_ATTEMPTS || response.status !== 429 && response.status < 500) return response;
      } catch (error) {
        if (attempt === REQUEST_ATTEMPTS) throw error;
      }
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  async function get(path, redirects = 0) {
    const response = await request(`https://openlibrary.org${path}.json`);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location'), 'https://openlibrary.org');
      if (redirects >= 2 || target.origin !== 'https://openlibrary.org' || !/^\/books\/OL\d+M\.json$/.test(target.pathname) || target.search) throw new Error('Unexpected metadata redirect');
      return get(target.pathname.slice(0, -5), redirects + 1);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Metadata request failed');
    const data = await response.json();
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Malformed metadata');
    return data;
  }
  async function googleCover(isbn) {
    try {
      const response = await request(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (!data || Array.isArray(data) || typeof data !== 'object' || !Array.isArray(data.items)) return null;
      return data.items.filter(item => hasIsbn13(item, isbn)).map(item => googleCoverUrl(item.volumeInfo.imageLinks)).find(Boolean) ?? null;
    } catch { return null; }
  }
  return async value => {
    const isbn = isbn13(value);
    const edition = await get(`/isbn/${isbn}`);
    if (!edition) return null;
    const refs = edition.authors;
    if (!Array.isArray(refs) || !refs.length || refs.length > 8) return null;
    const authors = [];
    for (const ref of refs) {
      if (!/^\/authors\/OL\d+A$/.test(ref?.key)) return null;
      authors.push((await get(ref.key))?.name);
    }
    let work = {};
    const key = edition.works?.[0]?.key;
    if (/^\/works\/OL\d+W$/.test(key)) work = await get(key) ?? {};
    const metadata = mapEdition(isbn, edition, authors, work);
    if (metadata && !metadata.coverImageUrl) metadata.coverImageUrl = await googleCover(isbn);
    return metadata;
  };
}
export async function saveMetadata(db, metadata, apply) {
  return serializable(db, async tx => {
    const { genres, ...fields } = metadata;
    const existing = await tx.book.findUnique({ where: { isbn: fields.isbn }, include: { bookGenres: { include: { genre: true } } } });
    // Missing optional metadata is not evidence that an existing value should be erased.
    const changes = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== null && !(key === 'coverImageUrl' && isGoogleBooksCover(value) && isOpenLibraryCover(existing?.coverImageUrl))));
    const existingSlugs = new Set(existing?.bookGenres.map(row => row.genre.slug) ?? []);
    const additions = genres.filter(g => !existingSlugs.has(g.slug));
    const outcome = !existing ? 'created' : Object.entries(changes).some(([key, value]) => existing[key] !== value) || additions.length ? 'updated' : 'unchanged';
    if (!apply || outcome === 'unchanged') return outcome;
    const book = await tx.book.upsert({ where: { isbn: fields.isbn }, create: fields, update: changes });
    for (const item of additions) {
      const genre = await tx.genre.upsert({ where: { slug: item.slug }, create: item, update: {} });
      await tx.bookGenre.upsert({ where: { bookId_genreId: { bookId: book.id, genreId: genre.id } }, create: { bookId: book.id, genreId: genre.id }, update: {} });
    }
    return outcome;
  });
}
export async function importCatalog(manifest, { resolve, save, report = () => {} }) {
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > 500) throw new Error('Manifest must contain 1–500 entries');
  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, resolved: 0 };
  const seen = new Set();
  // Validate all entries before the first request or write.
  const entries = manifest.map(entry => {
    try { return isbn13(entry?.isbn); } catch { summary.failed++; report('Invalid ISBN entry'); return null; }
  });
  for (const isbn of entries) {
    if (!isbn) continue;
    if (seen.has(isbn)) { summary.skipped++; continue; }
    seen.add(isbn);
    try {
      const data = await resolve(isbn);
      if (!data) { summary.skipped++; report(`${isbn}: incomplete or not found`); continue; }
      summary.resolved++;
      summary[await save(data)]++;
    } catch { summary.failed++; report(`${isbn}: failed (metadata or database operation)`); }
  }
  return summary;
}
