import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('book forms preserve drafts through likes, review pages, shelf saves and failed refreshes', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
  dom.window.confirm = () => true;
  const original = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, run) => run() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;
  const { createElement: h, act } = await import('react');
  t.after(async () => {
    if (root) await act(async () => root.unmount());
    session?.destroy();
    await server?.close();
    dom.window.close();
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const bookId = 'book-a';
  const stamp = '2026-09-06T10:00:00.000Z';
  let user = { id: 'reader-a', username: 'reader' };
  let personal = { bookId, shelf: { status: 'want_to_read', userRating: 4, updatedAt: stamp },
    review: { id: 'own', rating: 4, reviewText: 'Saved text', updatedAt: stamp } };
  let hold = false, liked = false, failWrite = false, pending = [], writes = [], deletions = [];
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const read = url => {
    if (url.pathname.startsWith('/api/user-books/')) return { data: personal };
    const page = Number(url.searchParams.get('page') || 1);
    return { data: { id: bookId, title: 'A test book', author: 'An author', genres: [], averageRating: 4,
      reviews: { data: [{ id: `other-${page}`, rating: 3, reviewText: `Public page ${page}`, createdAt: stamp,
        user: { id: 'other', username: 'another-reader' }, likesCount: liked ? 1 : 0, likedByMe: liked }],
      pagination: { page, limit: 10, total: 20, totalPages: 2 } } } };
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/login') return response({ user,
      accessToken: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 900 }))}.signature`, expiresIn: 900 });
    if (options.method === 'PUT') { liked = true; return response({ data: { liked: true } }); }
    if (options.method === 'DELETE') {
      deletions.push(url.pathname + url.search);
      if (url.pathname.startsWith('/api/reviews/')) personal = { ...personal, review: null };
      if (url.pathname.startsWith('/api/user-books/')) personal = { ...personal, shelf: null };
      return response({ data: { deleted: true } });
    }
    if (options.method === 'POST') {
      if (failWrite) {
        failWrite = false;
        return response({ error: { code: 'UNAVAILABLE', message: 'Please retry' } }, 503);
      }
      const body = JSON.parse(options.body); writes.push({ path: url.pathname, body });
      if (url.pathname === '/api/user-books') {
        personal = { ...personal, shelf: { ...personal.shelf, ...body, updatedAt: 'changed-shelf' } };
        return response({ data: personal.shelf });
      }
      personal = { ...personal, review: { ...personal.review, ...body, updatedAt: 'saved-review' },
        shelf: { ...personal.shelf, userRating: body.rating, updatedAt: 'synced-shelf' } };
      return response({ data: personal.review });
    }
    if (hold) return new Promise(resolve => pending.push({ url, resolve }));
    return response(read(url));
  };
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const { default: BookDetails } = await server.ssrLoadModule('/src/pages/BookDetails.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route, Link } = await import('react-router-dom');
  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: [`/books/${bookId}`] },
    h(Link, { to: '/books/book-b' }, 'Another book'),
    h(Routes, null, h(Route, { path: '/books/:id', element: h(BookDetails) })))));

  const textarea = document.querySelector('textarea');
  const shelfForm = document.querySelector('.reading-form');
  const reviewForm = document.querySelector('.review-form');
  assert.ok(textarea, 'initial personal data must load');
  const change = async (element, value) => act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === 'TEXTAREA' ? 'input' : 'change', { bubbles: true }));
  });
  const click = async text => act(async () => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
    assert.ok(button, `button ${text} exists`); button.click();
  });
  const flush = async (fail = false) => act(async () => {
    const requests = pending; pending = [];
    assert.ok(requests.length, 'refetch is pending');
    requests.forEach(({ url, resolve }) => resolve(fail
      ? response({ error: { code: 'UNAVAILABLE', message: 'Please retry' } }, 503) : response(read(url))));
  });
  const draft = 'My unfinished review — keep every word.';
  const preserved = () => {
    assert.equal(document.querySelector('textarea'), textarea, 'textarea must not remount');
    assert.equal(document.querySelector('.reading-form'), shelfForm, 'shelf must not remount');
    assert.equal(document.querySelector('.review-form'), reviewForm, 'review form must not remount');
    assert.equal(textarea.value, draft);
    assert.equal(textarea.disabled, false);
  };
  await change(textarea, draft);
  await change(reviewForm.querySelector('select'), '2');
  hold = true;
  await click('Like0'); preserved();
  assert.ok(document.body.textContent.includes('Updating book and reviews…'));
  // Users can continue typing even while the network response is pending.
  await change(textarea, draft + ' More');
  await flush();
  assert.equal(textarea.value, draft + ' More');
  await change(textarea, draft);
  await click('Next'); preserved(); await flush(); preserved();
  assert.ok(document.body.textContent.includes('Public page 2'));
  await change(shelfForm.querySelector('select'), 'currently_reading');
  await click('Save changes'); preserved();
  assert.ok(document.body.textContent.includes('Updating your reading data…'));
  await flush(); preserved();
  assert.equal(reviewForm.querySelector('select').value, '2', 'dirty rating survives status change');
  assert.equal(writes[0].body.status, 'currently_reading');
  assert.equal(writes[0].body.userRating, undefined, 'shelf save does not send userRating');
  await click('Previous'); preserved(); await flush(true); preserved();
  assert.ok(document.body.textContent.includes('Showing previously loaded book and reviews.'));
  await click('Try again'); await flush(); preserved();
  failWrite = true;
  const successfulWrites = writes.length;
  await click('Save review'); preserved();
  assert.equal(writes.length, successfulWrites, 'failed save must not pretend to persist a review');
  assert.equal(reviewForm.querySelector('fieldset').disabled, false, 'failed save unlocks the form');
  assert.ok(reviewForm.querySelector('[role="alert"]').textContent.includes('Please retry'));
  await click('Save review'); await flush();
  assert.equal(reviewForm.querySelector('[role="alert"]'), null, 'successful retry clears the error');
  assert.equal(writes.at(-1).body.reviewText, draft);
  assert.equal(writes.at(-1).body.rating, 2);

  let confirmDialogMessage = '';
  dom.window.confirm = (msg) => {
    confirmDialogMessage = msg;
    return true;
  };
  assert.ok(document.body.textContent.includes('Deleting your review keeps your rating.'));
  await click('Delete review');
  assert.equal(confirmDialogMessage, 'Delete your review? Your rating will remain.');
  assert.ok(document.body.textContent.includes('Your review has been deleted. Your rating remains.'));
  assert.deepEqual(deletions, ['/api/reviews/own']);
  assert.equal(document.querySelector('.review-form legend').textContent, 'What stayed with you?');
  assert.equal(document.querySelector('.review-form textarea').value, '');
  assert.equal(document.querySelector('.reading-form select').value, 'currently_reading', 'deleting a review keeps shelf status');
  assert.equal([...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Delete review'), false);
  await flush(true);
  assert.equal(document.querySelector('.review-form legend').textContent, 'What stayed with you?', 'a failed reconciliation cannot restore a deleted review');
  assert.equal([...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Delete review'), false);
  assert.ok(document.body.textContent.includes('Showing previously loaded reading data.'));

  await change(textarea, draft);
  await click('Save review'); await flush();

  let confirmResult = false;
  dom.window.confirm = (msg) => {
    assert.equal(msg, 'Remove this book from My Books?');
    return confirmResult;
  };
  await click('Remove from My Books');
  assert.deepEqual(deletions, ['/api/reviews/own']);
  
  confirmResult = true;
  await click('Remove from My Books');
  assert.deepEqual(deletions, ['/api/reviews/own', `/api/user-books/${bookId}`]);
  assert.ok(document.querySelector('.reading-form').textContent.includes('Add to my books'));
  await flush(true);
  assert.ok(document.querySelector('.reading-form').textContent.includes('Add to my books'));
  assert.equal([...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Remove from My Books'), false);
  assert.ok(document.body.textContent.includes('Showing previously loaded reading data.'));

  // Retained personal data and drafts must not leak into another account.
  hold = false;
  user = { id: 'reader-b', username: 'second-reader' };
  personal = { bookId, shelf: null, review: null };
  await act(async () => session.authenticate('login', {}));
  assert.notEqual(document.querySelector('textarea'), textarea);
  assert.equal(document.querySelector('textarea').value, '');
  await change(document.querySelector('textarea'), 'A different account draft');
  hold = true;
  await act(async () => document.querySelector('a[href="/books/book-b"]').click());
  assert.equal(document.querySelector('textarea'), null, 'another book must wait for its own personal data');
  personal = { bookId: 'book-b', shelf: null, review: null };
  await flush();
  assert.equal(document.querySelector('textarea').value, '');
});
