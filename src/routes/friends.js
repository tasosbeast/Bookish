import { Router } from 'express';
import * as controller from '../controllers/friends.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  friendSuggestionsSchema,
  searchReadersSchema,
  sendFriendRequestSchema,
  friendRequestIdSchema,
  removeFriendSchema,
  listFriendsSchema,
} from '../validators/index.js';

export const friendsRouter = Router();
friendsRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
friendsRouter.use(requireAuth);

friendsRouter.get('/suggestions', validate(friendSuggestionsSchema), controller.suggestions);
friendsRouter.get('/search', validate(searchReadersSchema), controller.searchReaders);
friendsRouter.get('/requests', validate(listFriendsSchema), controller.listRequests);
friendsRouter.post('/requests', validate(sendFriendRequestSchema), controller.sendRequest);
friendsRouter.post('/requests/:id/accept', validate(friendRequestIdSchema), controller.acceptRequest);
friendsRouter.delete('/requests/:id', validate(friendRequestIdSchema), controller.deleteRequest);

friendsRouter.get('/', validate(listFriendsSchema), controller.listFriends);
friendsRouter.delete('/:id', validate(removeFriendSchema), controller.removeFriend);
