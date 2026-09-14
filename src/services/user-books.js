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
    let shelfData = shelf;
    if (shelf) {
      let finishedOn = null;
      if (shelf.status === 'read') {
        const latestFinished = await tx.activity.findFirst({
          where: { userId, bookId, type: 'finished_reading' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { finishedOn: true, createdAt: true },
        });
        if (latestFinished?.finishedOn) {
          finishedOn = latestFinished.finishedOn instanceof Date
            ? latestFinished.finishedOn.toISOString().slice(0, 10)
            : String(latestFinished.finishedOn).slice(0, 10);
        } else if (latestFinished?.createdAt) {
          finishedOn = latestFinished.createdAt instanceof Date
            ? latestFinished.createdAt.toISOString().slice(0, 10)
            : String(latestFinished.createdAt).slice(0, 10);
        }
      }
      shelfData = { ...shelf, finishedOn };
    }
    return { data: { bookId, shelf: shelfData, review } };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function listShelves(userId, { status, q, page, limit }) {
  const search = q?.replace(/[\\%_]/g, '\\$&');
  const where = {
    userId,
    status: status !== undefined ? status : { not: null },
    ...(search && {
      book: {
        OR: ['title', 'author'].map(field => ({ [field]: { contains: search, mode: 'insensitive' } })),
      },
    }),
  };
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
