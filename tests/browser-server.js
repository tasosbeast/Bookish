// Optional manual browser verification harness. Never targets the development database.
import './setup.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, watchFile, unwatchFile, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { signup } from '../src/services/auth.js';
import { saveReview, saveShelf } from '../src/services/ratings.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Explicit TEST_DATABASE_URL is required');
const tag = randomUUID().slice(0, 8), bookIds = [], userIds = [];
const username = `ui_${tag}`, newUsername = `new_${tag}`;
const password = 'Bookish browser fixture 2026';
let genre, secondGenre, server, commands;
let failRead = false, failWrite = false;
const controlFile = join(tmpdir(), `bookish-browser-${tag}.control`);
async function cleanup() {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
  await prisma.user.deleteMany({ where: { OR: [{ id: { in: userIds } }, { email: `${newUsername}@example.com` }] } });
  if (genre) await prisma.genre.deleteMany({ where: { id: genre.id } });
  if (secondGenre) await prisma.genre.deleteMany({ where: { id: secondGenre.id } });
  commands?.close();
  unwatchFile(controlFile);
  try { unlinkSync(controlFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await prisma.$disconnect();
}
try {
  genre = await prisma.genre.create({ data: { name: `Browser fiction ${tag}`, slug: `browser-fiction-${tag}` } });
  secondGenre = await prisma.genre.create({ data: { name: `Browser essays ${tag}`, slug: `browser-essays-${tag}` } });
  for (let i = 1; i <= 20; i++) {
    const title = `The Quiet Chapter ${String(i).padStart(2, '0')}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="${i % 2 ? '#355c47' : '#8a543c'}"/><path d="M35 30h230v390H35z" fill="none" stroke="#ddcfaa"/><text x="150" y="130" text-anchor="middle" fill="#f7f6f0" font-family="Georgia" font-size="26">THE QUIET</text><text x="150" y="170" text-anchor="middle" fill="#f7f6f0" font-family="Georgia" font-size="26">CHAPTER ${i}</text><text x="150" y="370" text-anchor="middle" fill="#ddcfaa" font-size="16">BROWSER TEST FIXTURE</text></svg>`;
    const book = await prisma.book.create({ data: { title, author: 'Browser Fixture Author', publicationYear: 2000 + i,
      description: 'An isolated browser-test book for checking reading lists, ratings and reviews. These fixtures are removed when this test server stops.',
      coverImageUrl: i === 2 ? null : `data:image/svg+xml,${encodeURIComponent(svg)}`,
      bookGenres: { create: { genreId: i <= 10 ? genre.id : secondGenre.id } } } });
    bookIds.push(book.id);
  }
  const reader = await signup({ username, email: `${username}@example.com`, password }); userIds.push(reader.user.id);
  await saveReview(reader.user.id, { bookId: bookIds[0], rating: 4, reviewText: 'An existing personal review for browser verification.' });
  await prisma.review.update({ where: { userId_bookId: { userId: reader.user.id, bookId: bookIds[0] } }, data: { createdAt: new Date('2020-01-01') } });
  for (let i = 1; i <= 12; i++) {
    await saveShelf(reader.user.id, { bookId: bookIds[i], status: ['want_to_read', 'currently_reading', 'read'][i % 3], userRating: 3 });
    const critic = await signup({ username: `critic_${tag}_${i}`, email: `critic_${tag}_${i}@example.com`, password });
    userIds.push(critic.user.id);
    await saveReview(critic.user.id, { bookId: bookIds[0], rating: 3, reviewText: `Disposable public review ${i}.` });
  }
  // Fault injection is local-only and wraps the real API, never production routes.
  const browserApp = express();
  browserApp.use((req, res, next) => {
    const readFailure = failRead && req.method === 'GET' && /^\/api\/books\//.test(req.path);
    const writeFailure = failWrite && req.method === 'POST' && ['/api/reviews', '/api/user-books'].includes(req.path);
    if (readFailure || writeFailure) {
      if (readFailure) failRead = false;
      if (writeFailure) failWrite = false;
      console.log(`Injected 503: ${req.method} ${req.path}`);
      return res.set('Access-Control-Allow-Origin', process.env.CLIENT_ORIGIN)
        .set('Access-Control-Allow-Credentials', 'true').status(503)
        .json({ error: { code: 'TEST_UNAVAILABLE', message: 'Temporarily unavailable. Please try again.' } });
    }
    if (['PUT', 'DELETE'].includes(req.method) && req.path.endsWith('/like')) console.log(`Like command: ${req.method} ${req.path}`);
    next();
  });
  browserApp.use(app);
  function command(command) {
    if (command === 'fail-next-read') { failRead = true; console.log('Next book-detail read will fail once.'); }
    if (command === 'fail-next-write') { failWrite = true; console.log('Next shelf/review write will fail once.'); }
    if (command === 'stop') void cleanup().then(() => process.exit(0));
  }
  writeFileSync(controlFile, '');
  watchFile(controlFile, { interval: 150 }, () => {
    const value = readFileSync(controlFile, 'utf8').trim();
    if (value) { writeFileSync(controlFile, ''); command(value); }
  });
  server = browserApp.listen(3001, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://localhost:3001', bookId: bookIds[0], anotherBookId: bookIds[19], username, email: `${username}@example.com`, password, signupEmail: `${newUsername}@example.com`, signupUsername: newUsername, controlFile })));
  commands = createInterface({ input: process.stdin });
  commands.on('line', command);
  process.once('SIGINT', () => { void cleanup().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });
} catch (error) { await cleanup(); throw error; }
