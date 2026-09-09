import { normalizeIsbn13 } from '../normalize.js';
import { providerError, requestProvider, requireObject, responseJson } from './errors.js';

const PROVIDER = 'open_library';
const ORIGIN = 'https://openlibrary.org';
const USER_AGENT = 'BookishCatalogResolver/2.0 (curated catalog resolution; contact: local-project)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 2;

const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const strings = value => [...new Set((Array.isArray(value) ? value : [value]).map(text).filter(Boolean))];
const numberValues = value => [...new Set((Array.isArray(value) ? value : [value]).filter(item => Number.isSafeInteger(item) && item > 0))];
const descriptions = value => strings(typeof value === 'object' && value ? value.value : value);

function dateValues(...values) {
  return [...new Set(values.flatMap(value => Array.isArray(value) ? value : [value]).map(value => typeof value === 'number' ? String(value) : text(value)).filter(Boolean))];
}

function validIsbn13(values) {
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    try { normalized.push(normalizeIsbn13(value)); } catch { /* Provider candidates may contain invalid identifiers. */ }
  }
  return [...new Set(normalized)];
}

function years(values) {
  return [...new Set(strings(values).flatMap(value => value.match(/\b\d{4}\b/g) ?? []).map(Number))].filter(year => year >= 1000 && year <= new Date().getFullYear() + 1);
}

function keyId(value, pattern) {
  const match = typeof value === 'string' && value.match(pattern);
  return match?.[1] ?? null;
}

function authorValues(value) {
  const items = Array.isArray(value) ? value : [];
  return {
    names: strings(items.map(item => typeof item === 'string' ? item : item?.name)),
    keys: strings(items.map(item => item?.key ?? item?.author?.key)).map(key => keyId(key, /^\/?authors\/(OL\d+A)$/)).filter(Boolean),
  };
}

function languageValues(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .map(item => typeof item === 'string' ? item : item?.key)
    .map(item => keyId(item, /^\/?languages\/([^/]+)$/) ?? text(item))
    .filter(Boolean))];
}

function candidate(source, { workId = null, editionId = null, sourceType }) {
  const authorData = authorValues(source.author_name ?? source.authors);
  const coverIds = numberValues(source.cover_i ?? source.covers);
  const dates = dateValues(source.publish_date, source.published_date, source.publish_year, source.first_publish_year);
  return {
    provider: PROVIDER,
    sourceType,
    providerIds: { workId, editionId },
    rawTitle: typeof source.title === 'string' ? source.title : null,
    title: text(source.title),
    subtitle: text(source.subtitle),
    authors: authorData.names,
    authorKeys: authorData.keys,
    languages: languageValues(source.language ?? source.languages),
    isbn13: validIsbn13(source.isbn_13 ?? source.isbn),
    publishers: strings(source.publisher ?? source.publishers),
    formats: strings(source.physical_format ?? source.physical_formats),
    publicationDates: dates,
    publicationYears: years(dates),
    coverIds,
    coverImageUrls: coverIds.map(id => `https://covers.openlibrary.org/b/id/${id}-L.jpg?default=false`),
    descriptions: descriptions(source.description),
    subjects: strings(source.subject ?? source.subjects),
  };
}

function workId(value) {
  const id = keyId(value, /^(?:\/works\/)?(OL\d+W)$/);
  if (!id) throw providerError({ provider: PROVIDER, stage: 'work', code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Open Library work id must be an OL work id' });
  return id;
}

function editionId(value) {
  const id = keyId(value, /^(?:\/books\/)?(OL\d+M)$/);
  if (!id) throw providerError({ provider: PROVIDER, stage: 'edition', code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Open Library edition id must be an OL edition id' });
  return id;
}

function allowedRedirectTarget(url) {
  return !url.search && /^\/(?:books\/OL\d+M|works\/OL\d+W|authors\/OL\d+A|isbn\/97[89]\d{10})\.json$/.test(url.pathname);
}

export function createOpenLibraryClient({ fetchImpl = fetch, sleep, timeout, userAgent = USER_AGENT } = {}) {
  async function getJson(url, stage, redirects = 0) {
    const request = await requestProvider({
      provider: PROVIDER,
      stage,
      url,
      fetchImpl,
      sleep,
      timeout,
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      redirect: 'manual',
      acceptedStatuses: [404],
    });
    const { response, attempts } = request;
    if (response.status === 404) return null;
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      let target;
      try { target = new URL(location, url); } catch (cause) {
        throw providerError({ provider: PROVIDER, stage, code: 'unexpected_redirect', status: response.status, retryable: false, attempts, message: 'Open Library returned an invalid redirect', cause });
      }
      if (redirects >= MAX_REDIRECTS || target.origin !== ORIGIN || !allowedRedirectTarget(target)) {
        throw providerError({ provider: PROVIDER, stage, code: 'unexpected_redirect', status: response.status, retryable: false, attempts, message: 'Open Library returned an unexpected redirect target' });
      }
      return getJson(target.toString(), stage, redirects + 1);
    }
    return requireObject({ provider: PROVIDER, stage, value: await responseJson({ provider: PROVIDER, stage, response, attempts }), attempts });
  }

  return {
    async searchWorks({ title, author }) {
      const normalizedTitle = text(title);
      const normalizedAuthor = text(author);
      if (!normalizedTitle || !normalizedAuthor) throw providerError({ provider: PROVIDER, stage: 'search', code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Open Library search requires title and author' });
      const url = new URL('/search.json', ORIGIN);
      url.searchParams.set('title', normalizedTitle);
      url.searchParams.set('author', normalizedAuthor);
      url.searchParams.set('fields', 'key,title,subtitle,author_name,author_key,language,isbn,isbn_13,publisher,publish_year,first_publish_year,cover_i,subject,edition_key');
      const data = await getJson(url.toString(), 'search');
      if (data === null) return [];
      if (!Array.isArray(data.docs)) throw providerError({ provider: PROVIDER, stage: 'search', code: 'malformed_response', status: null, retryable: false, attempts: 1, message: 'Open Library search response is missing docs' });
      return data.docs.map(doc => {
        requireObject({ provider: PROVIDER, stage: 'search', value: doc, attempts: 1, message: 'search response contains an invalid work' });
        return candidate(doc, {
          workId: keyId(doc.key, /^\/?works\/(OL\d+W)$/),
          editionId: keyId(doc.edition_key?.[0], /^(OL\d+M)$/),
          sourceType: 'work_search',
        });
      });
    },

    async fetchWork(value) {
      const id = workId(value);
      const data = await getJson(`${ORIGIN}/works/${id}.json`, 'work');
      return data === null ? null : candidate(data, { workId: id, sourceType: 'work' });
    },

    async fetchEdition(value) {
      const id = editionId(value);
      const data = await getJson(`${ORIGIN}/books/${id}.json`, 'edition');
      return data === null ? null : candidate(data, { workId: keyId(data?.works?.[0]?.key, /^\/?works\/(OL\d+W)$/), editionId: id, sourceType: 'edition' });
    },

    async fetchEditionsForWork(value, { limit = 50 } = {}) {
      const id = workId(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw providerError({ provider: PROVIDER, stage: 'editions', code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Open Library editions limit must be 1–100' });
      const url = new URL(`/works/${id}/editions.json`, ORIGIN);
      url.searchParams.set('limit', String(limit));
      const data = await getJson(url.toString(), 'editions');
      if (data === null) return [];
      if (!Array.isArray(data.entries)) throw providerError({ provider: PROVIDER, stage: 'editions', code: 'malformed_response', status: null, retryable: false, attempts: 1, message: 'Open Library editions response is missing entries' });
      return data.entries.map(entry => {
        requireObject({ provider: PROVIDER, stage: 'editions', value: entry, attempts: 1, message: 'Open Library editions response contains an invalid edition' });
        return candidate(entry, { workId: id, editionId: keyId(entry.key, /^\/?books\/(OL\d+M)$/), sourceType: 'edition' });
      });
    },
  };
}
