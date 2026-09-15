import { getReleases, getUtcTodayString } from '../services/releases.js';

export async function list(req, res) {
  const { limit, asOf = getUtcTodayString() } = req.validated.query;
  res.json(await getReleases({ limit, asOf }));
}
