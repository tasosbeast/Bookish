import { prisma } from '../lib/prisma.js';
import { genres, serializeBook, pageInfo } from './books.js';

export async function listShelves(userId, { status, page, limit }) {
  const where = { userId, ...(status !== undefined && { status }) };
  const [entries, total] = await prisma.$transaction([
    prisma.userBook.findMany({ where, skip: (page - 1) * limit, take: limit,
      orderBy: [{ updatedAt: 'desc' }, { bookId: 'asc' }],
      select: { bookId: true, status: true, userRating: true, createdAt: true, updatedAt: true,
        book: { include: genres } },
    }),
    prisma.userBook.count({ where }),
  ], { isolationLevel: 'RepeatableRead' });
  return { data: entries.map(entry => ({ ...entry, book: serializeBook(entry.book) })),
    pagination: pageInfo(page, limit, total) };
}
