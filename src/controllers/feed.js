import * as feedService from '../services/feed.js';

export async function list(req, res) {
  const result = await feedService.listFeed(req.auth.userId, req.validated.query);
  res.json(result);
}
