import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Discover pagination scroll behavior, filter preservation, history navigation and reduced motion', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173' });
  const scrollCalls = [];
  dom.window.Element.prototype.scrollIntoView = function(options) {
    scrollCalls.push({
      tagName: this.tagName.toLowerCase(),
      className: this.className,
      ariaLabelledby: this.getAttribute('aria-labelledby'),
      options,
    });
  };

  const original = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    BroadcastChannel: undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(navigator, 'locks', { value: { request: (_key, _options, work) => work() } });
  const nativeFetch = globalThis.fetch;
  let server, root, session;

  t.after(async () => {
    if (root) {
      const { act } = await import('react');
      await act(async () => root.unmount());
    }
    session?.destroy();
    await server?.close();
    dom.window.close();
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of original) {
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
    }
  });

  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/api/genres') {
      return Response.json({
        data: [
          { id: '1', name: 'Fiction', slug: 'fiction' },
          { id: '2', name: 'Fantasy', slug: 'fantasy' },
        ],
      });
    }
    if (url.pathname === '/api/recommendations/top-picks') {
      return Response.json({ data: [], meta: { personalized: false } });
    }
    if (url.pathname === '/api/books') {
      const requestedPage = Number(url.searchParams.get('page') || '1');
      const genre = url.searchParams.get('genre') || '';
      return Response.json({
        data: [
          {
            id: `book-${requestedPage}-${genre || 'all'}`,
            title: `Book on page ${requestedPage} (${genre || 'all'})`,
            author: 'Jane Austen',
            coverImageUrl: null,
            averageRating: null,
            genres: [],
          },
        ],
        pagination: {
          page: requestedPage,
          limit: 18,
          total: 36,
          totalPages: 2,
        },
      });
    }
    return Response.json({});
  };

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { default: Discover } = await server.ssrLoadModule('/src/pages/Discover.jsx');
  ({ session } = await server.ssrLoadModule('/src/lib/api.js'));
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, useLocation, useNavigate } = await import('react-router-dom');

  let historyNavigate;
  function NavWatcher() {
    historyNavigate = useNavigate();
    return h('output', { id: 'location' }, useLocation().search);
  }

  await session.authenticate('login', {});
  root = createRoot(document.getElementById('root'));

  // 1. Initial render at page 1
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/'] }, h(Discover), h(NavWatcher))));

  assert.ok(document.body.textContent.includes('Book on page 1'), 'Page 1 book loaded');
  assert.equal(scrollCalls.length, 0, 'Initial Discover render does NOT trigger scrollIntoView');

  // 2. Typing in search without changing page does not scroll
  const searchInput = document.querySelector('#book-search');
  assert.ok(searchInput, 'Search input exists');
  await act(async () => {
    searchInput.value = 'Pride';
    searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(scrollCalls.length, 0, 'Typing in search does NOT trigger scrollIntoView');

  // 3. Changing genre filter while on page 1 does NOT scroll
  const fictionBtn = [...document.querySelectorAll('.genre-filter')].find(b => b.textContent === 'Fiction');
  assert.ok(fictionBtn, 'Fiction filter button exists');
  await act(async () => {
    fictionBtn.click();
  });
  assert.equal(scrollCalls.length, 0, 'Changing filter while remaining on page 1 does NOT trigger scrollIntoView');
  assert.ok(document.body.textContent.includes('fiction'), 'Filtered books loaded');

  // 4. Changing pagination page triggers scrollIntoView exactly once
  const nextButton = [...document.querySelectorAll('.pagination button')].find(btn => btn.textContent.includes('Next'));
  assert.ok(nextButton, 'Next page button exists');
  assert.equal(nextButton.disabled, false, 'Next page button is not disabled');

  await act(async () => {
    nextButton.click();
  });

  assert.equal(scrollCalls.length, 1, 'Changing pagination page triggers scrollIntoView exactly once');
  assert.equal(scrollCalls[0].className, 'catalog-section', 'Scroll target is catalog-section');
  assert.equal(scrollCalls[0].ariaLabelledby, 'discover-heading');
  assert.deepEqual(scrollCalls[0].options, { behavior: 'smooth', block: 'start' });
  assert.ok(document.body.textContent.includes('Book on page 2'), 'New page 2 still loads normally');
  assert.ok(document.querySelector('#location').textContent.includes('page=2'));

  // 5. Browser back navigation (back to page 1) triggers scrollIntoView
  await act(async () => {
    historyNavigate(-1);
  });
  assert.equal(scrollCalls.length, 2, 'Browser history back navigation triggers scrollIntoView');
  assert.equal(scrollCalls[1].className, 'catalog-section');
  assert.deepEqual(scrollCalls[1].options, { behavior: 'smooth', block: 'start' });
  assert.ok(document.body.textContent.includes('Book on page 1'), 'Page 1 reloaded after history back');

  // 6. Initial render with direct link to page 2 does NOT scroll
  await act(async () => root.unmount());
  scrollCalls.length = 0;
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(h(MemoryRouter, { initialEntries: ['/?page=2'] }, h(Discover), h(NavWatcher))));

  assert.ok(document.body.textContent.includes('Book on page 2'));
  assert.equal(scrollCalls.length, 0, 'Initial render on direct page=2 link does NOT trigger scrollIntoView');

  // 7. Reduced-motion preference uses behavior: 'auto'
  dom.window.matchMedia = query => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });

  const prevOnPage2 = [...document.querySelectorAll('.pagination button')].find(btn => btn.textContent.includes('Previous'));
  await act(async () => {
    prevOnPage2.click();
  });

  assert.equal(scrollCalls.length, 1, 'Changing page with prefers-reduced-motion triggers scrollIntoView');
  assert.deepEqual(scrollCalls[0].options, { behavior: 'auto', block: 'start' }, 'Uses auto behavior when reduced-motion preferred');
});
