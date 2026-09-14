import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { serializable } from '../lib/transaction.js';

async function requireBook(tx, bookId) {
  if (!await tx.book.findUnique({ where: { id: bookId }, select: { id: true } })) {
    throw new AppError(404, 'BOOK_NOT_FOUND', 'Book not found');
  }
}
async function refreshRating(tx, bookId) {
  const aggregate = await tx.userBook.aggregate({ where: { bookId, userRating: { not: null } },
    _avg: { userRating: true }, _count: { userRating: true } });
  await tx.book.update({ where: { id: bookId }, data: {
    averageRating: aggregate._avg.userRating, ratingsCount: aggregate._count.userRating,
  } });
}
export async function saveShelf(userId, { bookId, status, userRating, finishedOn }) {
  return serializable(prisma, async tx => {
    await requireBook(tx, bookId);
    const key = { userId_bookId: { userId, bookId } };
    if (userRating === null && await tx.review.findUnique({ where: key, select: { id: true } })) {
      throw new AppError(409, 'REVIEW_REQUIRES_RATING', 'Cannot clear a rating while a review exists');
    }
    const existingUserBook = await tx.userBook.findUnique({
      where: key,
      select: { status: true, userRating: true },
    });
    const previousStatus = existingUserBook?.status ?? null;
    const previousRating = existingUserBook?.userRating ?? null;

    const effectiveStatus = status !== undefined ? status : previousStatus;
    if (finishedOn !== undefined && effectiveStatus !== 'read') {
      throw new AppError(400, 'INVALID_SHELF_STATUS', 'Date finished is only valid for books marked read');
    }

    const updateData = {
      ...(status !== undefined && { status }),
      ...(userRating !== undefined && { userRating }),
    };
    const createData = {
      userId,
      bookId,
      status: status !== undefined ? status : null,
      ...(userRating !== undefined && { userRating }),
    };
    const shelf = await tx.userBook.upsert({ where: key, create: createData, update: updateData });
    if (userRating !== undefined) {
      if (userRating !== null) await tx.review.updateMany({ where: { userId, bookId }, data: { rating: userRating } });
      await refreshRating(tx, bookId);
    }

    const isTransitionToRead = status !== undefined && status !== previousStatus && status === 'read';

    if (status !== undefined && status !== previousStatus && status === 'currently_reading') {
      await tx.activity.create({
        data: {
          userId,
          bookId,
          type: 'started_reading',
        },
      });
    } else if (isTransitionToRead) {
      const targetDateStr = finishedOn ?? new Date().toISOString().slice(0, 10);
      const targetFinishedOn = new Date(`${targetDateStr}T00:00:00.000Z`);
      await tx.activity.create({
        data: {
          userId,
          bookId,
          type: 'finished_reading',
          finishedOn: targetFinishedOn,
        },
      });
    } else if (userRating !== undefined && userRating !== null && userRating !== previousRating) {
      await tx.activity.create({
        data: {
          userId,
          bookId,
          type: 'rated_book',
          rating: userRating,
        },
      });
    }

    if (effectiveStatus === 'read' && !isTransitionToRead && finishedOn !== undefined) {
      const latestFinished = await tx.activity.findFirst({
        where: {
          userId,
          bookId,
          type: 'finished_reading',
        },
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      });
      const targetFinishedOn = new Date(`${finishedOn}T00:00:00.000Z`);
      if (latestFinished) {
        await tx.activity.update({
          where: { id: latestFinished.id },
          data: { finishedOn: targetFinishedOn },
        });
      } else {
        await tx.activity.create({
          data: {
            userId,
            bookId,
            type: 'finished_reading',
            finishedOn: targetFinishedOn,
          },
        });
      }
    }

    return shelf;
  });
}
export async function removeShelf(userId, bookId) {
  return serializable(prisma, async tx => {
    await requireBook(tx, bookId);
    const key = { userId_bookId: { userId, bookId } };
    const shelf = await tx.userBook.findUnique({ where: key, select: { userRating: true } });
    if (!shelf) throw new AppError(404, 'SHELF_NOT_FOUND', 'This book is not in your books');
    const review = await tx.review.findUnique({ where: key, select: { id: true } });
    if (shelf.userRating !== null || review) {
      await tx.userBook.update({ where: key, data: { status: null } });
    } else {
      await tx.userBook.delete({ where: key });
    }
    return { bookId, removed: true };
  });
}
export async function saveReview(userId, { bookId, rating, reviewText }) {
  return serializable(prisma, async tx => {
    await requireBook(tx, bookId);
    const key = { userId_bookId: { userId, bookId } };
    const existing = await tx.userBook.findUnique({ where: key, select: { status: true } });
    if (!existing) {
      await tx.userBook.create({ data: { userId, bookId, status: null, userRating: rating } });
    } else {
      await tx.userBook.update({ where: key, data: { userRating: rating } });
    }
    const existingReview = await tx.review.findUnique({ where: key, select: { id: true } });
    const text = reviewText === undefined ? {} : { reviewText };
    const review = await tx.review.upsert({ where: key, create: { userId, bookId, rating, ...text }, update: { rating, ...text } });
    if (!existingReview) {
      await tx.activity.create({
        data: {
          userId,
          bookId,
          reviewId: review.id,
          type: 'reviewed_book',
          rating,
          reviewTextSnapshot: review.reviewText ?? null,
        },
      });
    }
    await refreshRating(tx, bookId);
    return review;
  });
}
export async function removeReview(userId, reviewId) {
  return serializable(prisma, async tx => {
    const result = await tx.review.deleteMany({ where: { id: reviewId, userId } });
    if (result.count === 0) throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    // UserBook.userRating is canonical and remains unchanged, so the book aggregate also remains unchanged.
    return { reviewId, deleted: true };
  });
}
export async function setReviewLike(userId, reviewId, liked) {
  return serializable(prisma, async tx => {
    const review = await tx.review.findUnique({ where: { id: reviewId }, select: { id: true, userId: true } });
    if (!review) {
      throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    }
    if (liked) {
      await tx.reviewLike.upsert({ where: { userId_reviewId: { userId, reviewId } },
        create: { userId, reviewId }, update: {} });
      if (review.userId !== userId) {
        await tx.notification.upsert({
          where: {
            recipientId_actorId_reviewId_type: {
              recipientId: review.userId,
              actorId: userId,
              reviewId,
              type: 'review_like',
            },
          },
          create: {
            recipientId: review.userId,
            actorId: userId,
            reviewId,
            type: 'review_like',
          },
          update: {},
        });
      }
    } else {
      await tx.reviewLike.deleteMany({ where: { userId, reviewId } });
      await tx.notification.deleteMany({
        where: {
          recipientId: review.userId,
          actorId: userId,
          reviewId,
          type: 'review_like',
        },
      });
    }
    const likesCount = await tx.reviewLike.count({ where: { reviewId } });
    await tx.review.update({ where: { id: reviewId }, data: { likesCount } });
    return { reviewId, liked, likesCount };
  });
}
