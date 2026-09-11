import * as friendSuggestionsService from '../services/friendSuggestionsService.js';
import * as friendshipService from '../services/friendshipService.js';

export async function suggestions(req, res) {
  const result = await friendSuggestionsService.getFriendSuggestions(req.auth.userId, req.validated.query);
  res.json(result);
}

export async function listFriends(req, res) {
  const result = await friendshipService.getFriends(req.auth.userId);
  res.json(result);
}

export async function listRequests(req, res) {
  const result = await friendshipService.getRequests(req.auth.userId);
  res.json(result);
}

export async function sendRequest(req, res) {
  const result = await friendshipService.sendRequest(req.auth.userId, req.validated.body.userId);
  res.status(201).json(result);
}

export async function acceptRequest(req, res) {
  const result = await friendshipService.acceptRequest(req.auth.userId, req.validated.params.id);
  res.json(result);
}

export async function deleteRequest(req, res) {
  const result = await friendshipService.deleteRequest(req.auth.userId, req.validated.params.id);
  res.json(result);
}

export async function removeFriend(req, res) {
  const result = await friendshipService.removeFriend(req.auth.userId, req.validated.params.id);
  res.json(result);
}
