import * as challengesService from '../services/challenges.js';

export async function getCurrent(req, res) {
  const result = await challengesService.getCurrentChallenge(req.auth.userId);
  res.json(result);
}

export async function getTrophies(req, res) {
  const result = await challengesService.getUserTrophies(req.auth.userId);
  res.json(result);
}
