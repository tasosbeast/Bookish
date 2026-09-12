-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'friend_request';

-- DropForeignKey
ALTER TABLE notifications DROP CONSTRAINT notifications_review_id_fkey;

-- AlterTable
ALTER TABLE notifications ALTER COLUMN review_id DROP NOT NULL,
ADD COLUMN friendship_id UUID;

-- CreateIndex
CREATE UNIQUE INDEX notifications_recipient_id_friendship_id_type_key ON notifications(recipient_id, friendship_id, type);

-- CreateIndex
CREATE INDEX notifications_friendship_id_idx ON notifications(friendship_id);

-- AddForeignKey
ALTER TABLE notifications ADD CONSTRAINT notifications_review_id_fkey FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE notifications ADD CONSTRAINT notifications_friendship_id_fkey FOREIGN KEY (friendship_id) REFERENCES friendships(id) ON DELETE CASCADE ON UPDATE CASCADE;
