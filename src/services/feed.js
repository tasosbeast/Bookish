import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor({ createdAt, id }) {
  const payload = JSON.stringify({ createdAt, id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(cursorStr) {
  if (typeof cursorStr !== 'string' || !cursorStr) return null;
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || !UUID_REGEX.test(parsed.id)) return null;
    if (typeof parsed.createdAt !== 'string' || !parsed.createdAt) return null;
    const date = new Date(parsed.createdAt);
    if (isNaN(date.getTime())) return null;
    return { createdAt: date, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listFeed(userId, { limit = 20, cursor } = {}) {
  let decodedCursor = null;
  if (cursor !== undefined) {
    decodedCursor = decodeCursor(cursor);
    if (!decodedCursor) {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
    }
  }

  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'accepted',
      acceptedAt: { not: null },
      OR: [
        { userAId: userId },
        { userBId: userId },
      ],
    },
    select: {
      userAId: true,
      userBId: true,
      acceptedAt: true,
    },
  });

  if (friendships.length === 0) {
    return { data: [], meta: { nextCursor: null } };
  }

  const friendConditions = friendships.map(f => ({
    userId: f.userAId === userId ? f.userBId : f.userAId,
    createdAt: { gte: f.acceptedAt },
  }));

  const cursorCondition = decodedCursor ? {
    OR: [
      { createdAt: { lt: decodedCursor.createdAt } },
      {
        createdAt: decodedCursor.createdAt,
        id: { lt: decodedCursor.id },
      },
    ],
  } : null;

  const where = {
    AND: [
      { OR: friendConditions },
      { historical: false },
      ...(cursorCondition ? [cursorCondition] : []),
    ],
  };

  const activities = await prisma.activity.findMany({
    where,
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
    take: limit + 1,
    select: {
      id: true,
      type: true,
      createdAt: true,
      rating: true,
      reviewTextSnapshot: true,
      user: {
        select: {
          id: true,
          username: true,
          profilePicture: true,
        },
      },
      book: {
        select: {
          id: true,
          title: true,
          author: true,
          coverImageUrl: true,
          isbn: true,
        },
      },
      review: {
        select: {
          id: true,
        },
      },
    },
  });

  const hasMore = activities.length > limit;
  const items = (hasMore ? activities.slice(0, limit) : activities).map(a => ({
    id: a.id,
    type: a.type,
    createdAt: a.createdAt.toISOString(),
    actor: {
      id: a.user.id,
      username: a.user.username,
      profilePicture: a.user.profilePicture,
    },
    book: {
      id: a.book.id,
      title: a.book.title,
      author: a.book.author,
      coverImageUrl: a.book.coverImageUrl,
      isbn: a.book.isbn,
    },
    rating: a.rating ?? null,
    review: a.type === 'reviewed_book' && a.review ? {
      id: a.review.id,
      reviewText: a.reviewTextSnapshot ?? null,
    } : null,
  }));

  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor({ createdAt: lastItem.createdAt, id: lastItem.id }) : null;

  return {
    data: items,
    meta: {
      nextCursor,
    },
  };
}
