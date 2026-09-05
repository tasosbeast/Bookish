// Require an explicitly named test database before any integration fixture can be written.
if (process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^\/[a-zA-Z0-9_]+_test$/.test(url.pathname)) {
    throw new Error('TEST_DATABASE_URL must point to a dedicated PostgreSQL database whose name ends in _test');
  }
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/bookish_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-'.repeat(4);
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-'.repeat(4);
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.TRUST_PROXY_HOPS = '0';
