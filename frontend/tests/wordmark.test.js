import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Bookish logo accessible name is Bookish', { timeout: 60000 }, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:5173/' });
  const original = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.window.scrollTo = () => {};

  let server, root;
  t.after(async () => {
    if (root) { const { act } = await import('react'); await act(async () => root.unmount()); }
    await server?.close();
    dom.window.close();
    for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });

  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { default: Layout } = await server.ssrLoadModule('/src/components/Layout.jsx');
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router-dom');

  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: ['/'] },
      h(Routes, null,
        h(Route, { element: h(Layout) },
          h(Route, { index: true, element: h('div') })))));
  });

  for (const selector of ['.brand', '.footer-brand']) {
    const link = document.querySelector(selector);
    assert.ok(link, `${selector} wordmark is rendered`);
    assert.equal(link.getAttribute('aria-label'), 'Bookish', `${selector} accessible name is Bookish`);
    assert.equal(link.getAttribute('href'), '/');

    const wordmark = link.querySelector('.wordmark');
    assert.equal(wordmark.getAttribute('aria-hidden'), 'true');
    const parts = [...wordmark.childNodes].map(node => (node.nodeType === 3 ? node.textContent : node.nodeName.toLowerCase()));
    assert.deepEqual(parts, ['B', 'svg', 'kish', 'span']);
    assert.equal(wordmark.querySelector('.brand-dot').textContent, '.');

    const icon = wordmark.querySelector('svg');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.match(icon.querySelector('path').getAttribute('d'), /^M12 5/);
    assert.equal(link.querySelector(':scope > svg'), null);
  }
});
