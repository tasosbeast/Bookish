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
export async function saveShelf(userId, { bookId, status, userRating }) {
  return serializable(prisma, async tx => {
    await requireBook(tx, bookId);
    const key = { userId_bookId: { userId, bookId } };
    if (userRating === null && await tx.review.findUnique({ where: key, select: { id: true } })) {
      throw new AppError(409, 'REVIEW_REQUIRES_RATING', 'Cannot clear a rating while a review exists');
    }
    const changes = { ...(status !== undefined && { status }), ...(userRating !== undefined && { userRating }) };
    const shelf = await tx.userBook.upsert({ where: key,
      create: { userId, bookId, ...changes }, update: changes });
    if (userRating !== undefined) {
      if (userRating !== null) await tx.review.updateMany({ where: { userId, bookId }, data: { rating: userRating } });
      await refreshRating(tx, bookId);
    }
    return shelf;
  });
}
export async function saveReview(userId, { bookId, rating, reviewText }) {
  return serializable(prisma, async tx => {
    await requireBook(tx, bookId);
    const key = { userId_bookId: { userId, bookId } };
    await tx.userBook.upsert({ where: key, create: { userId, bookId, userRating: rating }, update: { userRating: rating } });
    const text = reviewText === undefined ? {} : { reviewText };
    const review = await tx.review.upsert({ where: key, create: { userId, bookId, rating, ...text }, update: { rating, ...text } });
    await refreshRating(tx, bookId);
    return review;
  });
}
export async function setReviewLike(userId, reviewId, liked) {
  return serializable(prisma, async tx => {
    if (!await tx.review.findUnique({ where: { id: reviewId }, select: { id: true } })) {
      throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    }
    if (liked) {
      await tx.reviewLike.upsert({ where: { userId_reviewId: { userId, reviewId } },
        create: { userId, reviewId }, update: {} });
    } else {
      await tx.reviewLike.deleteMany({ where: { userId, reviewId } });
    }
    const likesCount = await tx.reviewLike.count({ where: { reviewId } });
    await tx.review.update({ where: { id: reviewId }, data: { likesCount } });
    return { reviewId, liked, likesCount };
  });
}
