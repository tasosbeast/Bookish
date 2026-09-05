import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.js';

// Retry the entire unit of work; never perform HTTP calls or other external side effects here.
export async function serializable(db, work, { attempts = 5, sleep = delay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000,
      });
    } catch (error) {
      // A concurrent first insert can surface as a unique-key conflict instead of P2034.
      if (!['P2034', 'P2002'].includes(error.code)) throw error;
      if (attempt === attempts - 1) {
        if (error.code === 'P2002') throw error;
        throw new AppError(503, 'TRANSACTION_BUSY', 'Concurrent update; please retry');
      }
      await sleep(20 * 2 ** attempt + Math.floor(Math.random() * 25));
    }
  }
}
