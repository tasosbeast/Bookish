// Optional manual browser verification harness. Never targets the development database.
import './setup.js';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { signup } from '../src/services/auth.js';
import { saveReview } from '../src/services/ratings.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Explicit TEST_DATABASE_URL is required');
const tag = randomUUID().slice(0, 8), bookIds = [], userIds = [];
const username = `ui_${tag}`, newUsername = `new_${tag}`;
const password = 'Bookish browser fixture 2026';
let genre, server;
async function cleanup() {
  if (server) await new Promise(resolve => server.close(resolve));
  await prisma.book.deleteMany({ where: { id: { in: bookIds } } });
  await prisma.user.deleteMany({ where: { OR: [{ id: { in: userIds } }, { email: `${newUsername}@example.com` }] } });
  if (genre) await prisma.genre.deleteMany({ where: { id: genre.id } });
  await prisma.$disconnect();
}
try {
  genre = await prisma.genre.create({ data: { name: `Browser fiction ${tag}`, slug: `browser-fiction-${tag}` } });
  for (let i = 1; i <= 20; i++) {
    const title = `The Quiet Chapter ${String(i).padStart(2, '0')}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="${i % 2 ? '#355c47' : '#8a543c'}"/><path d="M35 30h230v390H35z" fill="none" stroke="#ddcfaa"/><text x="150" y="130" text-anchor="middle" fill="#f7f6f0" font-family="Georgia" font-size="26">THE QUIET</text><text x="150" y="170" text-anchor="middle" fill="#f7f6f0" font-family="Georgia" font-size="26">CHAPTER ${i}</text><text x="150" y="370" text-anchor="middle" fill="#ddcfaa" font-size="16">BROWSER TEST FIXTURE</text></svg>`;
    const book = await prisma.book.create({ data: { title, author: 'Browser Fixture Author', publicationYear: 2000 + i,
      description: 'An isolated browser-test book for checking reading lists, ratings and reviews. These fixtures are removed when this test server stops.',
      coverImageUrl: i === 2 ? null : `data:image/svg+xml,${encodeURIComponent(svg)}`,
      bookGenres: { create: { genreId: genre.id } } } });
    bookIds.push(book.id);
  }
  const reader = await signup({ username, email: `${username}@example.com`, password }); userIds.push(reader.user.id);
  await saveReview(reader.user.id, { bookId: bookIds[0], rating: 4, reviewText: 'An existing personal review for browser verification.' });
  server = app.listen(3001, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://localhost:3001', bookId: bookIds[0], username, email: `${username}@example.com`, password, signupEmail: `${newUsername}@example.com`, signupUsername: newUsername })));
  process.once('SIGINT', () => { void cleanup().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });
} catch (error) { await cleanup(); throw error; }
