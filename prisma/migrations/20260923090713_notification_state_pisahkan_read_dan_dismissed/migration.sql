-- DropIndex
DROP INDEX `notification_states_userId_idx` ON `notification_states`;

-- DropIndex
DROP INDEX `notification_states_userId_notificationId_key` ON `notification_states`;

-- AlterTable
ALTER TABLE `notification_states` ADD COLUMN `state` VARCHAR(16) NOT NULL DEFAULT 'read';

-- CreateIndex
CREATE INDEX `notification_states_userId_state_idx` ON `notification_states`(`userId`, `state`);

-- CreateIndex
CREATE UNIQUE INDEX `notification_states_userId_notificationId_state_key` ON `notification_states`(`userId`, `notificationId`, `state`);

