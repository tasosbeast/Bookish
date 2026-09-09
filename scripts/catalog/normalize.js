const text = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : null;

function folded(value) {
  const source = text(value);
  if (!source) return '';
  return source.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function normalizeTitle(value) {
  return folded(value).replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|an|a)\s+/, '');
}

export function normalizeAuthorName(value) {
  const normalized = folded(value).replace(/['’]/g, '').replace(/[^a-z0-9,]+/g, ' ').trim().replace(/\s+/g, ' ');
  const comma = normalized.match(/^(.+),\s*(.+)$/);
  return comma ? `${comma[2]} ${comma[1]}`.trim() : normalized;
}

export function normalizeStableKey(value) {
  return folded(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeIsbn13(value) {
  if (typeof value !== 'string') throw new Error('ISBN-13 must be a string');
  const isbn = value.replace(/[ -]/g, '');
  if (!/^97[89]\d{10}$/.test(isbn) || [...isbn].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) {
    throw new Error('Invalid ISBN-13');
  }
  return isbn;
}

export function normalizeGenreName(value) {
  const normalized = text(value);
  if (!normalized) throw new Error('Genre name is required');
  return normalized;
}

export function normalizeGenreSlug(value) {
  const slug = folded(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Genre slug is required');
  return slug;
}

export function normalizeGenre(genre) {
  if (!genre || typeof genre !== 'object' || Array.isArray(genre)) throw new Error('Genre must be an object');
  const name = normalizeGenreName(genre.name);
  const slug = normalizeGenreSlug(genre.slug ?? name);
  if (genre.slug !== undefined && text(genre.slug) !== slug) throw new Error('Genre slug must be normalized');
  return { name, slug };
}

export function normalizeDisplayText(value, field) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
