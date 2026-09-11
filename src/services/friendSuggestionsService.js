import { prisma } from '../lib/prisma.js';

export async function getFriendSuggestions(userId, { limit = 12 } = {}) {
  const currentUserBooks = await prisma.userBook.findMany({
    where: { userId },
    include: {
      book: {
        include: {
          bookGenres: {
            include: { genre: true },
          },
        },
      },
    },
  });

  function getWeight(ub) {
    if (ub.status === 'read' || ub.userRating != null) return 1.0;
    if (ub.status === 'currently_reading') return 0.5;
    return 0.0;
  }

  const eligibleUserBooks = currentUserBooks.filter(ub => getWeight(ub) > 0);
  const eligibleBooksCount = eligibleUserBooks.length;

  if (eligibleBooksCount < 5) {
    return {
      data: [],
      meta: {
        personalized: false,
        eligibleBooks: eligibleBooksCount,
        minimumBooks: 5,
      },
    };
  }

  const userGenreWeights = {};
  const userEligibleBookIds = new Set();
  const userRatingsMap = new Map();

  for (const ub of eligibleUserBooks) {
    const weight = getWeight(ub);
    userEligibleBookIds.add(ub.bookId);
    if (ub.userRating != null) {
      userRatingsMap.set(ub.bookId, ub.userRating);
    }
    for (const bg of ub.book.bookGenres) {
      const gName = bg.genre.name;
      userGenreWeights[gName] = (userGenreWeights[gName] || 0) + weight;
    }
  }

  let userNormSq = 0;
  for (const w of Object.values(userGenreWeights)) {
    userNormSq += w * w;
  }
  const userNorm = Math.sqrt(userNormSq);

  const existingFriendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { userAId: userId },
        { userBId: userId },
      ],
    },
  });

  const excludedUserIds = new Set([userId]);
  for (const f of existingFriendships) {
    excludedUserIds.add(f.userAId === userId ? f.userBId : f.userAId);
  }

  const candidateUserBooks = await prisma.userBook.findMany({
    where: {
      userId: { notIn: Array.from(excludedUserIds) },
    },
    include: {
      user: true,
      book: {
        include: {
          bookGenres: {
            include: { genre: true },
          },
        },
      },
    },
  });

  const candidateMap = new Map();
  for (const ub of candidateUserBooks) {
    if (!candidateMap.has(ub.userId)) {
      candidateMap.set(ub.userId, { user: ub.user, userBooks: [] });
    }
    candidateMap.get(ub.userId).userBooks.push(ub);
  }

  const scoredCandidates = [];

  for (const [candId, candData] of candidateMap.entries()) {
    const candEligibleUBs = candData.userBooks.filter(ub => getWeight(ub) > 0);
    if (candEligibleUBs.length < 5) continue;

    const candGenreWeights = {};
    const candEligibleBookIds = new Set();
    const candRatingsMap = new Map();

    for (const ub of candEligibleUBs) {
      const weight = getWeight(ub);
      candEligibleBookIds.add(ub.bookId);
      if (ub.userRating != null) {
        candRatingsMap.set(ub.bookId, ub.userRating);
      }
      for (const bg of ub.book.bookGenres) {
        const gName = bg.genre.name;
        candGenreWeights[gName] = (candGenreWeights[gName] || 0) + weight;
      }
    }

    let candNormSq = 0;
    for (const w of Object.values(candGenreWeights)) {
      candNormSq += w * w;
    }
    const candNorm = Math.sqrt(candNormSq);

    let genreSimilarity = 0;
    if (userNorm > 0 && candNorm > 0) {
      for (const [g, w] of Object.entries(userGenreWeights)) {
        if (candGenreWeights[g]) {
          genreSimilarity += (w / userNorm) * (candGenreWeights[g] / candNorm);
        }
      }
    }

    let commonRatedCount = 0;
    let agreementSum = 0;
    for (const [bId, rA] of userRatingsMap.entries()) {
      if (candRatingsMap.has(bId)) {
        const rB = candRatingsMap.get(bId);
        const agreement = 1 - Math.abs(rA - rB) / 4;
        agreementSum += agreement;
        commonRatedCount += 1;
      }
    }

    let ratingSignal = 0;
    if (commonRatedCount > 0) {
      const avgAgreement = agreementSum / commonRatedCount;
      ratingSignal = avgAgreement * Math.min(commonRatedCount / 5, 1);
    }

    let sharedBookCount = 0;
    for (const bId of userEligibleBookIds) {
      if (candEligibleBookIds.has(bId)) {
        sharedBookCount += 1;
      }
    }

    const unionSize = new Set([...userEligibleBookIds, ...candEligibleBookIds]).size;
    const sharedBookSignal = unionSize > 0 ? sharedBookCount / unionSize : 0;

    const finalScore = 0.60 * genreSimilarity + 0.25 * ratingSignal + 0.15 * sharedBookSignal;

    const sharedGenres = [];
    for (const g of Object.keys(userGenreWeights)) {
      if (candGenreWeights[g]) {
        sharedGenres.push({
          name: g,
          score: userGenreWeights[g] + candGenreWeights[g],
        });
      }
    }
    sharedGenres.sort((a, b) => b.score - a.score);
    const topSharedGenreNames = sharedGenres.slice(0, 2).map(g => g.name);

    let reason;
    if (topSharedGenreNames.length > 0) {
      reason = {
        type: 'genres',
        genres: topSharedGenreNames,
        commonRatedBooks: commonRatedCount,
        sharedBooks: sharedBookCount,
      };
    } else if (commonRatedCount > 0) {
      reason = {
        type: 'ratings',
        genres: [],
        commonRatedBooks: commonRatedCount,
        sharedBooks: sharedBookCount,
      };
    } else {
      reason = {
        type: 'shared_books',
        genres: [],
        commonRatedBooks: 0,
        sharedBooks: sharedBookCount,
      };
    }

    scoredCandidates.push({
      user: {
        id: candData.user.id,
        username: candData.user.username,
        profilePicture: candData.user.profilePicture,
        bio: candData.user.bio,
      },
      reason,
      finalScore,
      genreSimilarity,
      sharedBookCount,
    });
  }

  scoredCandidates.sort((a, b) => {
    if (Math.abs(b.finalScore - a.finalScore) > 1e-7) {
      return b.finalScore - a.finalScore;
    }
    if (Math.abs(b.genreSimilarity - a.genreSimilarity) > 1e-7) {
      return b.genreSimilarity - a.genreSimilarity;
    }
    if (b.sharedBookCount !== a.sharedBookCount) {
      return b.sharedBookCount - a.sharedBookCount;
    }
    if (a.user.username !== b.user.username) {
      return a.user.username.localeCompare(b.user.username);
    }
    return a.user.id.localeCompare(b.user.id);
  });

  const sliced = scoredCandidates.slice(0, limit);

  return {
    data: sliced.map(c => ({
      user: c.user,
      reason: c.reason,
    })),
    meta: {
      personalized: true,
      eligibleBooks: eligibleBooksCount,
      minimumBooks: 5,
    },
  };
}
