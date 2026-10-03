import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../vite.config.js';
import { avatarHostsFromEnv } from '../src/lib/avatarHosts.js';
import { DEFAULT_AVATAR_HOSTS } from '../src/lib/avatarUrl.js';

test('vite build rejects an invalid VITE_AVATAR_ALLOWED_HOSTS', () => {
  const previousHosts = process.env.VITE_AVATAR_ALLOWED_HOSTS;
  const previousApi = process.env.VITE_API_BASE_URL;
  process.env.VITE_API_BASE_URL = 'https://api.example.com/api';
  try {
    process.env.VITE_AVATAR_ALLOWED_HOSTS = '*.co.uk';
    assert.throws(() => config({ mode: 'production' }), /Invalid VITE_AVATAR_ALLOWED_HOSTS/);
    process.env.VITE_AVATAR_ALLOWED_HOSTS = 'www.gravatar.com,lh3.googleusercontent.com';
    assert.doesNotThrow(() => config({ mode: 'production' }));
  } finally {
    if (previousHosts === undefined) delete process.env.VITE_AVATAR_ALLOWED_HOSTS;
    else process.env.VITE_AVATAR_ALLOWED_HOSTS = previousHosts;
    if (previousApi === undefined) delete process.env.VITE_API_BASE_URL;
    else process.env.VITE_API_BASE_URL = previousApi;
  }
});

test('an invalid avatar host list falls back to the default hosts', () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    assert.deepEqual(avatarHostsFromEnv('*.co.uk'), DEFAULT_AVATAR_HOSTS);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /VITE_AVATAR_ALLOWED_HOSTS/);
    assert.deepEqual(avatarHostsFromEnv('www.gravatar.com'), ['www.gravatar.com']);
  } finally {
    console.error = original;
  }
});
