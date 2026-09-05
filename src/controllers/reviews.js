import { saveReview, setReviewLike } from '../services/ratings.js';
export async function save(req, res) { res.json({ data: await saveReview(req.auth.userId, req.validated.body) }); }
export async function like(req, res) { res.json({ data: await setReviewLike(req.auth.userId, req.validated.params.id, true) }); }
export async function unlike(req, res) { res.json({ data: await setReviewLike(req.auth.userId, req.validated.params.id, false) }); }
