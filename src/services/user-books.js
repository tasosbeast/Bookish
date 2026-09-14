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
  return prisma.$transaction(async tx => {
    const [entries, total] = await Promise.all([
      tx.userBook.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ updatedAt: 'desc' }, { bookId: 'asc' }],
        select: {
          bookId: true,
          status: true,
          userRating: true,
          createdAt: true,
          updatedAt: true,
          book: { include: genres },
        },
      }),
      tx.userBook.count({ where }),
    ]);

    const readBookIds = entries.filter(e => e.status === 'read').map(e => e.bookId);
    const finishedOnByBookId = new Map();

    if (readBookIds.length > 0) {
      const activities = await tx.activity.findMany({
        where: {
          userId,
          bookId: { in: readBookIds },
          type: 'finished_reading',
        },
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        select: {
          bookId: true,
          finishedOn: true,
        },
      });

      for (const act of activities) {
        if (!finishedOnByBookId.has(act.bookId)) {
          const dateStr = act.finishedOn
            ? (act.finishedOn instanceof Date ? act.finishedOn.toISOString().slice(0, 10) : String(act.finishedOn).slice(0, 10))
            : null;
          finishedOnByBookId.set(act.bookId, dateStr);
        }
      }
    }

    const data = entries.map(entry => ({
      bookId: entry.bookId,
      status: entry.status,
      userRating: entry.userRating,
      finishedOn: entry.status === 'read' ? (finishedOnByBookId.get(entry.bookId) ?? null) : null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      book: serializeBook(entry.book),
    }));

    return {
      data,
      pagination: pageInfo(page, limit, total),
    };
  }, { isolationLevel: 'RepeatableRead' });
}
