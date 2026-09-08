import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export const pageInfo = (page, limit, total) => ({ page, limit, total, totalPages: Math.ceil(total / limit) });
export const genres = { bookGenres: { select: { genre: { select: { id: true, name: true, slug: true } } } } };
export function serializeBook(book) {
  const { bookGenres, ...fields } = book;
  return { ...fields, averageRating: book.averageRating === null ? null : Number(book.averageRating),
    genres: bookGenres.map(row => row.genre) };
}
export function bookFilter({ q, genre, author }) {
  // Prisma parameterizes contains + insensitive as PostgreSQL ILIKE.
  // Escape LIKE metacharacters so the user's query is a literal substring.
  const search = q?.replace(/[\\%_]/g, '\\$&');
  const authorSearch = author?.replace(/[\\%_]/g, '\\$&');
  return {
    ...(genre && { bookGenres: { some: { genre: { slug: genre } } } }),
    ...(authorSearch && { author: { contains: authorSearch, mode: 'insensitive' } }),
    ...(search && { OR: ['title', 'author'].map(field => ({ [field]: { contains: search, mode: 'insensitive' } })) }),
  };
}
export async function listBooks(query) {
  const { page, limit, sort, order } = query;
  const where = bookFilter(query);
  const [books, total] = await prisma.$transaction([
    prisma.book.findMany({ where, include: genres, skip: (page - 1) * limit, take: limit,
      orderBy: [{ [sort === 'rating' ? 'averageRating' : 'publicationYear']: { sort: order, nulls: 'last' } }, { id: 'asc' }] }),
    prisma.book.count({ where }),
  ], { isolationLevel: 'RepeatableRead' });
  return { data: books.map(serializeBook), pagination: pageInfo(page, limit, total) };
}
export async function bookDetails(id, { page, limit }, userId) {
  return prisma.$transaction(async tx => {
    const book = await tx.book.findUnique({ where: { id }, include: genres });
    if (!book) throw new AppError(404, 'BOOK_NOT_FOUND', 'Book not found');
    const where = { bookId: id };
    const reviews = await tx.review.findMany({ where, skip: (page - 1) * limit, take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { user: { select: { id: true, username: true, profilePicture: true } } } });
    const total = await tx.review.count({ where });
    // One bounded query for the whole review page, within the same read snapshot.
    const likes = userId && reviews.length ? await tx.reviewLike.findMany({
      where: { userId, reviewId: { in: reviews.map(review => review.id) } },
      select: { reviewId: true },
    }) : [];
    const likedIds = new Set(likes.map(like => like.reviewId));
    return { data: { ...serializeBook(book), reviews: {
      data: reviews.map(review => ({ ...review, likedByMe: likedIds.has(review.id) })),
      pagination: pageInfo(page, limit, total),
    } } };
  }, { isolationLevel: 'RepeatableRead' });
}
