import { saveReview, toggleLike } from '../services/ratings.js';
export async function save(req, res) { res.json({ data: await saveReview(req.auth.userId, req.validated.body) }); }
export async function like(req, res) { res.json({ data: await toggleLike(req.auth.userId, req.validated.params.id) }); }
