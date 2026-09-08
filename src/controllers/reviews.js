import { removeReview, saveReview, setReviewLike } from '../services/ratings.js';
export async function save(req, res) { res.json({ data: await saveReview(req.auth.userId, req.validated.body) }); }
export async function remove(req, res) { res.json({ data: await removeReview(req.auth.userId, req.validated.params.id) }); }
export async function like(req, res) { res.json({ data: await setReviewLike(req.auth.userId, req.validated.params.id, true) }); }
export async function unlike(req, res) { res.json({ data: await setReviewLike(req.auth.userId, req.validated.params.id, false) }); }
