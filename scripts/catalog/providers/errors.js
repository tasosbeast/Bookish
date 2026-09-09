import { setTimeout as delay } from 'node:timers/promises';

export const MAX_PROVIDER_ATTEMPTS = 3;
export const PROVIDER_RETRY_BACKOFF_MS = [500, 1500];
export const MAX_RETRY_AFTER_MS = 30_000;

export class CatalogProviderError extends Error {
  constructor({ provider, stage, code, status = null, retryable, attempts, message, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CatalogProviderError';
    this.provider = provider;
    this.stage = stage;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

export function providerError(details) {
  return new CatalogProviderError(details);
}

export function isRetryableStatus(status) {
  return status === 429 || status >= 500 && status <= 599;
}

export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(Math.round(Number(value) * 1000), MAX_RETRY_AFTER_MS);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - now), MAX_RETRY_AFTER_MS);
}

function networkCode(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT'
    ? 'timeout'
    : 'network_error';
}

function responseError({ provider, stage, response, attempts }) {
  const status = response.status;
  if (status === 429) return providerError({ provider, stage, code: 'http_429', status, retryable: true, attempts, message: `${provider} rate limited the request` });
  if (status >= 500 && status <= 599) return providerError({ provider, stage, code: 'http_5xx', status, retryable: true, attempts, message: `${provider} returned HTTP ${status}` });
  return providerError({ provider, stage, code: `http_${status}`, status, retryable: false, attempts, message: `${provider} returned HTTP ${status}` });
}

function requestUrl(value, provider, stage) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Provider URL must use HTTPS');
    return url;
  } catch (cause) {
    throw providerError({ provider, stage, code: 'invalid_request', status: null, retryable: false, attempts: 0, message: 'Provider request URL must be HTTPS', cause });
  }
}

export async function requestProvider({
  provider,
  stage,
  url,
  fetchImpl = fetch,
  sleep = delay,
  timeout = 10_000,
  headers = {},
  redirect = 'error',
  acceptedStatuses = [],
  now = () => Date.now(),
} = {}) {
  const target = requestUrl(url, provider, stage);
  const accepted = new Set(acceptedStatuses);

  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(target.toString(), {
        headers,
        signal: AbortSignal.timeout(timeout),
        redirect,
      });
      if (!response || typeof response.status !== 'number') {
        throw providerError({ provider, stage, code: 'invalid_response', status: null, retryable: false, attempts: attempt, message: `${provider} returned an invalid response` });
      }
      if (response.ok || response.status >= 300 && response.status <= 399 || accepted.has(response.status)) return { response, attempts: attempt, url: target };

      const error = responseError({ provider, stage, response, attempts: attempt });
      if (!error.retryable || attempt === MAX_PROVIDER_ATTEMPTS) throw error;
      const retryAfter = retryAfterMs(response.headers?.get('retry-after'), now());
      await sleep(retryAfter ?? PROVIDER_RETRY_BACKOFF_MS[attempt - 1]);
    } catch (error) {
      if (error instanceof CatalogProviderError) throw error;
      const code = networkCode(error);
      const providerFailure = providerError({
        provider,
        stage,
        code,
        status: null,
        retryable: true,
        attempts: attempt,
        message: code === 'timeout' ? `${provider} request timed out` : `${provider} network request failed`,
        cause: error,
      });
      if (attempt === MAX_PROVIDER_ATTEMPTS) throw providerFailure;
      await sleep(PROVIDER_RETRY_BACKOFF_MS[attempt - 1]);
    }
  }
}

export async function responseJson({ provider, stage, response, attempts }) {
  try {
    return await response.json();
  } catch (cause) {
    throw providerError({ provider, stage, code: 'malformed_response', status: response.status, retryable: false, attempts, message: `${provider} returned malformed JSON`, cause });
  }
}

export function requireObject({ provider, stage, value, attempts, message = 'returned an invalid response' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError({ provider, stage, code: 'malformed_response', status: null, retryable: false, attempts, message: `${provider} ${message}` });
  }
  return value;
}
