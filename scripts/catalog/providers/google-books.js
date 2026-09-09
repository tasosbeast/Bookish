import { normalizeIsbn13 } from '../normalize.js';
import { providerError, requestProvider, requireObject, responseJson } from './errors.js';

const PROVIDER = 'google_books';
const ORIGIN = 'https://www.googleapis.com';
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const strings = value => [...new Set((Array.isArray(value) ? value : [value]).map(text).filter(Boolean))];

function validIsbn13(values) {
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (value?.type !== 'ISBN_13') continue;
    try { normalized.push(normalizeIsbn13(value.identifier)); } catch { /* Ignore invalid provider identifiers. */ }
  }
  return [...new Set(normalized)];
}

function coverUrls(imageLinks) {
  if (!imageLinks || typeof imageLinks !== 'object' || Array.isArray(imageLinks)) return [];
  const preferred = ['extraLarge', 'large', 'medium', 'small', 'thumbnail', 'smallThumbnail'];
  const urls = [];
  for (const size of preferred) {
    try {
      const url = new URL(imageLinks[size]);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.protocol = 'https:';
      urls.push(url.toString());
    } catch { /* Ignore malformed provider image URLs. */ }
  }
  return [...new Set(urls)];
}

function publicationYears(value) {
  return [...new Set(strings(value).flatMap(item => item.match(/\b\d{4}\b/g) ?? []).map(Number))].filter(year => year >= 1000 && year <= new Date().getFullYear() + 1);
}

function candidate(volume) {
  requireObject({ provider: PROVIDER, stage: 'volume', value: volume, attempts: 1, message: 'response contains an invalid volume' });
  const info = requireObject({ provider: PROVIDER, stage: 'volume', value: volume.volumeInfo, attempts: 1, message: 'volume is missing volumeInfo' });
  if (!text(volume.id)) throw providerError({ provider: PROVIDER, stage: 'volume', code: 'malformed_response', status: null, retryable: false, attempts: 1, message: 'Google Books volume is missing an id' });
  const dates = strings(info.publishedDate);
  return {
    provider: PROVIDER,
    sourceType: 'volume',
    providerIds: { volumeId: volume.id.trim() },
    rawTitle: typeof info.title === 'string' ? info.title : null,
    title: text(info.title),
    subtitle: text(info.subtitle),
    authors: strings(info.authors),
    authorKeys: [],
    languages: strings(info.language),
    isbn13: validIsbn13(info.industryIdentifiers),
    publishers: strings(info.publisher),
    formats: strings([info.printType, info.printType === 'BOOK' ? info.binding : null]),
    publicationDates: dates,
    publicationYears: publicationYears(dates),
    coverIds: [],
    coverImageUrls: coverUrls(info.imageLinks),
    descriptions: strings(info.description),
    subjects: strings(info.categories),
  };
}

export function createGoogleBooksClient({ fetchImpl = fetch, sleep, timeout } = {}) {
  async function volumes(url, stage) {
    const { response, attempts } = await requestProvider({
      provider: PROVIDER,
      stage,
      url,
      fetchImpl,
      sleep,
      timeout,
      headers: { Accept: 'application/json' },
      acceptedStatuses: [404],
    });
    if (response.status === 404) return [];
    const data = requireObject({ provider: PROVIDER, stage, value: await responseJson({ provider: PROVIDER, stage, response, attempts }), attempts });
    if (data.items === undefined && data.totalItems === 0) return [];
    if (!Array.isArray(data.items)) throw providerError({ provider: PROVIDER, stage, code: 'malformed_response', status: null, retryable: false, attempts, message: 'Google Books response is missing items' });
    return data.items.map(candidate);
  }

  return {
    async searchVolumes({ title, author }) {
      const normalizedTitle = text(title);
      const normalizedAuthor = text(author);
      if (!normalizedTitle || !normalizedAuthor) throw providerError({ provider: PROVIDER, stage: 'search', code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Google Books search requires title and author' });
      const url = new URL('/books/v1/volumes', ORIGIN);
      url.searchParams.set('q', `intitle:${normalizedTitle} inauthor:${normalizedAuthor}`);
      url.searchParams.set('maxResults', '40');
      return volumes(url.toString(), 'search');
    },

    async lookupByIsbn(value) {
      let isbn;
      try { isbn = normalizeIsbn13(value); } catch (cause) {
        throw providerError({ provider: PROVIDER, stage: 'exact_isbn', code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Google Books exact lookup requires a valid ISBN-13', cause });
      }
      const url = new URL('/books/v1/volumes', ORIGIN);
      url.searchParams.set('q', `isbn:${isbn}`);
      url.searchParams.set('maxResults', '40');
      return (await volumes(url.toString(), 'exact_isbn')).find(item => item.isbn13.includes(isbn)) ?? null;
    },
  };
}
