import * as recommendationsService from '../services/recommendations.js';

export async function getTopPicks(req, res) {
  const limit = req.validated.query.limit;
  const result = await recommendationsService.getTopPicks(req.auth.userId, limit);
  res.json(result);
}
