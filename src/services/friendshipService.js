import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export function canonicalPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

export async function searchReaders(userId, { q, limit }) {
  const query = q.trim();
  const escapedQuery = escapeLike(query);
  const users = await prisma.$queryRaw`
    SELECT id, username, profile_picture AS "profilePicture", bio
    FROM users
    WHERE id <> ${userId}::uuid
      AND username ILIKE ${`%${escapedQuery}%`} ESCAPE E'\\\\'
    ORDER BY
      CASE
        WHEN lower(username) = lower(${query}) THEN 0
        WHEN username ILIKE ${`${escapedQuery}%`} ESCAPE E'\\\\' THEN 1
        ELSE 2
      END,
      lower(username) ASC,
      id ASC
    LIMIT ${limit}
  `;

  if (!users.length) return { data: [] };

  const ids = users.map(user => user.id);
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { userAId: userId, userBId: { in: ids } },
        { userBId: userId, userAId: { in: ids } },
      ],
    },
    select: { id: true, userAId: true, userBId: true, requestedById: true, status: true },
  });
  const relationships = new Map(friendships.map(friendship => [
    friendship.userAId === userId ? friendship.userBId : friendship.userAId,
    friendship,
  ]));

  return {
    data: users.map(user => {
      const friendship = relationships.get(user.id);
      let relationship = { status: 'none' };
      if (friendship?.status === 'accepted') {
        relationship = { status: 'accepted', friendshipId: friendship.id };
      } else if (friendship) {
        relationship = {
          status: 'pending',
          direction: friendship.requestedById === userId ? 'outgoing' : 'incoming',
          requestId: friendship.id,
        };
      }
      return { user, relationship };
    }),
  };
}

export async function getFriends(userId) {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'accepted',
      OR: [
        { userAId: userId },
        { userBId: userId },
      ],
    },
    include: {
      userA: {
        select: { id: true, username: true, profilePicture: true, bio: true },
      },
      userB: {
        select: { id: true, username: true, profilePicture: true, bio: true },
      },
    },
    orderBy: { acceptedAt: 'desc' },
  });

  const friends = friendships.map(f => {
    const friend = f.userAId === userId ? f.userB : f.userA;
    return {
      friendshipId: f.id,
      friend: {
        id: friend.id,
        username: friend.username,
        profilePicture: friend.profilePicture,
        bio: friend.bio,
      },
      acceptedAt: f.acceptedAt,
      createdAt: f.createdAt,
    };
  });

  return { data: friends };
}

export async function getRequests(userId) {
  const requests = await prisma.friendship.findMany({
    where: {
      status: 'pending',
      OR: [
        { userAId: userId },
        { userBId: userId },
      ],
    },
    include: {
      userA: {
        select: { id: true, username: true, profilePicture: true, bio: true },
      },
      userB: {
        select: { id: true, username: true, profilePicture: true, bio: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const incoming = [];
  const sent = [];

  for (const r of requests) {
    if (r.requestedById === userId) {
      const targetUser = r.userAId === userId ? r.userB : r.userA;
      sent.push({
        id: r.id,
        user: {
          id: targetUser.id,
          username: targetUser.username,
          profilePicture: targetUser.profilePicture,
          bio: targetUser.bio,
        },
        createdAt: r.createdAt,
      });
    } else {
      const senderUser = r.userAId === userId ? r.userB : r.userA;
      incoming.push({
        id: r.id,
        user: {
          id: senderUser.id,
          username: senderUser.username,
          profilePicture: senderUser.profilePicture,
          bio: senderUser.bio,
        },
        createdAt: r.createdAt,
      });
    }
  }

  return {
    data: {
      incoming,
      sent,
    },
  };
}

export async function sendRequest(currentUserId, targetUserId) {
  if (currentUserId === targetUserId) {
    throw new AppError(400, 'CANNOT_FRIEND_SELF', 'You cannot send a friend request to yourself.');
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true },
  });

  if (!targetUser) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  }

  const [userAId, userBId] = canonicalPair(currentUserId, targetUserId);

  const existing = await prisma.friendship.findUnique({
    where: {
      userAId_userBId: { userAId, userBId },
    },
  });

  if (existing) {
    if (existing.status === 'accepted') {
      throw new AppError(409, 'ALREADY_FRIENDS', 'You are already friends with this user.');
    }
    if (existing.status === 'pending') {
      throw new AppError(409, 'REQUEST_PENDING', 'A friend request is already pending between you and this user.');
    }
  }

  const friendship = await prisma.friendship.create({
    data: {
      userAId,
      userBId,
      requestedById: currentUserId,
      status: 'pending',
    },
  });

  return { data: friendship };
}

export async function acceptRequest(currentUserId, requestId) {
  const friendship = await prisma.friendship.findUnique({
    where: { id: requestId },
  });

  if (!friendship) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Friend request not found.');
  }

  if (friendship.status !== 'pending') {
    throw new AppError(400, 'INVALID_REQUEST_STATUS', 'Request is not pending.');
  }

  const isMember = friendship.userAId === currentUserId || friendship.userBId === currentUserId;
  if (!isMember || friendship.requestedById === currentUserId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the recipient of a friend request can accept it.');
  }

  const updated = await prisma.friendship.update({
    where: { id: requestId },
    data: {
      status: 'accepted',
      acceptedAt: new Date(),
    },
  });

  return { data: updated };
}

export async function deleteRequest(currentUserId, requestId) {
  const friendship = await prisma.friendship.findUnique({
    where: { id: requestId },
  });

  if (!friendship) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Friend request not found.');
  }

  if (friendship.status !== 'pending') {
    throw new AppError(400, 'INVALID_REQUEST_STATUS', 'Request is not pending.');
  }

  const isMember = friendship.userAId === currentUserId || friendship.userBId === currentUserId;
  if (!isMember) {
    throw new AppError(403, 'FORBIDDEN', 'You are not authorized to delete this request.');
  }

  await prisma.friendship.delete({
    where: { id: requestId },
  });

  return { data: { id: requestId, status: 'deleted' } };
}

export async function removeFriend(currentUserId, identifier) {
  let friendship = await prisma.friendship.findUnique({
    where: { id: identifier },
  });

  if (!friendship) {
    const [userAId, userBId] = canonicalPair(currentUserId, identifier);
    friendship = await prisma.friendship.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
    });
  }

  if (!friendship) {
    throw new AppError(404, 'FRIENDSHIP_NOT_FOUND', 'Friendship not found.');
  }

  if (friendship.status !== 'accepted') {
    throw new AppError(400, 'INVALID_FRIENDSHIP_STATUS', 'Friendship is not accepted.');
  }

  const isMember = friendship.userAId === currentUserId || friendship.userBId === currentUserId;
  if (!isMember) {
    throw new AppError(403, 'FORBIDDEN', 'You are not authorized to remove this friendship.');
  }

  await prisma.friendship.delete({
    where: { id: friendship.id },
  });

  return { data: { id: friendship.id, status: 'removed' } };
}
