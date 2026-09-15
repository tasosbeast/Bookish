import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_PRH_BASE_URL = 'https://api.penguinrandomhouse.com/title/client/Public/domains/PRH.US';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = [200, 500];

export class PrhApiError extends Error {
  constructor({ message, code, status = null, attempts = 0, retryable = false, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PrhApiError';
    this.code = code;
    this.status = status;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

export function sanitizeUrl(urlStr) {
  if (typeof urlStr !== 'string') return '';
  return urlStr.replace(/([?&]api_key=)[^&]+/gi, '$1[REDACTED]');
}

export function formatPrhDate(dateStr) {
  if (typeof dateStr !== 'string' || !dateStr.trim()) {
    throw new PrhApiError({
      message: 'Date string is required',
      code: 'invalid_date',
    });
  }
  const trimmed = dateStr.trim();
  // If already MM/dd/yyyy
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    return trimmed;
  }
  // If YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split('-');
    return `${month}/${day}/${year}`;
  }
  throw new PrhApiError({
    message: `Invalid date format: "${trimmed}". Expected YYYY-MM-DD or MM/dd/yyyy.`,
    code: 'invalid_date',
  });
}

export class PrhClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey !== undefined ? options.apiKey : process.env.PRH_API_KEY;
    this.baseUrl = (options.baseUrl || DEFAULT_PRH_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || delay;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  _requireApiKey() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || !this.apiKey.trim()) {
      throw new PrhApiError({
        message: 'PRH_API_KEY is not configured or is blank',
        code: 'missing_api_key',
        retryable: false,
      });
    }
  }

  async _request(pathAndQuery, { acceptedStatuses = [] } = {}) {
    this._requireApiKey();

    const delimiter = pathAndQuery.includes('?') ? '&' : '?';
    const rawUrl = `${this.baseUrl}${pathAndQuery}${delimiter}api_key=${encodeURIComponent(this.apiKey)}`;
    const sanitizedTarget = sanitizeUrl(rawUrl);
    const accepted = new Set(acceptedStatuses);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this.fetchImpl(rawUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeout),
        });

        const status = response.status;
        if (response.ok || accepted.has(status)) {
          return response;
        }

        const is429 = status === 429;
        const is5xx = status >= 500 && status <= 599;
        const retryable = is429 || is5xx;

        if (retryable && attempt < this.maxAttempts) {
          const retryAfterHeader = response.headers?.get('retry-after');
          let waitMs = this.backoffMs[attempt - 1] ?? 1000;
          if (retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())) {
            waitMs = Math.min(Number(retryAfterHeader.trim()) * 1000, 30_000);
          }
          await this.sleep(waitMs);
          continue;
        }

        throw new PrhApiError({
          message: `PRH API returned HTTP ${status} for ${sanitizeUrl(pathAndQuery)}`,
          code: is429 ? 'rate_limited' : (is5xx ? 'server_error' : `http_${status}`),
          status,
          attempts: attempt,
          retryable,
        });
      } catch (error) {
        if (error instanceof PrhApiError) {
          throw error;
        }

        const isAbortOrTimeout = error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
        const retryable = true;

        if (attempt < this.maxAttempts) {
          const waitMs = this.backoffMs[attempt - 1] ?? 1000;
          await this.sleep(waitMs);
          continue;
        }

        throw new PrhApiError({
          message: isAbortOrTimeout
            ? `PRH API request timed out for ${sanitizeUrl(pathAndQuery)}`
            : `PRH API network error: ${sanitizeUrl(error?.message || 'Network failure')}`,
          code: isAbortOrTimeout ? 'timeout' : 'network_error',
          attempts: attempt,
          retryable: false,
          cause: error,
        });
      }
    }
  }

  async listTitlesByOnSaleRange({ from, to, start = 0, rows = 100 }) {
    const formattedFrom = formatPrhDate(from);
    const formattedTo = formatPrhDate(to);
    const query = `/titles?onSaleFrom=${encodeURIComponent(formattedFrom)}&onSaleTo=${encodeURIComponent(formattedTo)}&start=${encodeURIComponent(start)}&rows=${encodeURIComponent(rows)}`;

    const response = await this._request(query);
    const json = await response.json();

    const titles = json?.data?.titles ?? [];
    const recordCount = typeof json?.recordCount === 'number' ? json.recordCount : titles.length;

    return {
      titles,
      recordCount,
      start,
      rows,
    };
  }

  async getTitleByIsbn(isbn) {
    if (!isbn) {
      throw new PrhApiError({ message: 'ISBN is required', code: 'invalid_isbn' });
    }
    const cleanIsbn = String(isbn).replace(/[ -]/g, '');
    const path = `/titles/${encodeURIComponent(cleanIsbn)}`;

    const response = await this._request(path, { acceptedStatuses: [404] });
    if (response.status === 404) {
      return null;
    }

    const json = await response.json();
    if (!json?.data) {
      return null;
    }

    if (Array.isArray(json.data.titles) && json.data.titles.length > 0) {
      return json.data.titles[0];
    }
    if (json.data && !Array.isArray(json.data)) {
      return json.data;
    }
    return null;
  }

  async getTitleCategories(isbn) {
    if (!isbn) {
      throw new PrhApiError({ message: 'ISBN is required', code: 'invalid_isbn' });
    }
    const cleanIsbn = String(isbn).replace(/[ -]/g, '');
    const path = `/titles/${encodeURIComponent(cleanIsbn)}/categories`;

    const response = await this._request(path, { acceptedStatuses: [404] });
    if (response.status === 404) {
      return [];
    }

    const json = await response.json();
    if (!json?.data) {
      return [];
    }

    if (Array.isArray(json.data.categories)) {
      return json.data.categories;
    }
    if (Array.isArray(json.data)) {
      return json.data;
    }
    return [];
  }
}
