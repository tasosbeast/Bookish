import { prisma } from '../lib/prisma.js';
import { genres, serializeBook, pageInfo } from './books.js';
import { AppError } from '../lib/errors.js';

export async function personalBook(userId, bookId) {
  return prisma.$transaction(async tx => {
    if (!await tx.book.findUnique({ where: { id: bookId }, select: { id: true } })) {
      throw new AppError(404, 'BOOK_NOT_FOUND', 'Book not found');
    }
    const where = { userId_bookId: { userId, bookId } };
    const shelf = await tx.userBook.findUnique({ where,
      select: { bookId: true, status: true, userRating: true, createdAt: true, updatedAt: true } });
    const review = await tx.review.findUnique({ where,
      select: { id: true, bookId: true, rating: true, reviewText: true, likesCount: true, createdAt: true, updatedAt: true } });
    return { data: { bookId, shelf, review } };
  }, { isolationLevel: 'RepeatableRead' });
}

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
