process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://test:test@localhost:5432/bookish_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-'.repeat(4);
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-'.repeat(4);
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.TRUST_PROXY_HOPS = '0';
