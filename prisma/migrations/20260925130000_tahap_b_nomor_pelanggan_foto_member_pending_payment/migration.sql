-- AlterTable
ALTER TABLE `memberships` MODIFY `status` ENUM('active', 'expired', 'cancelled', 'pending_payment') NOT NULL DEFAULT 'active';

-- Nomor pelanggan. SQL bawaan Prisma (ADD COLUMN ... AUTO_INCREMENT, lalu indeks di statement
-- terpisah) ditolak MySQL karena kolom AUTO_INCREMENT wajib ber-key di statement yang sama, dan
-- mengisi akun lama menurut urutan fisik uuid. Di sini akun lama dinomori urut tanggal daftar dulu,
-- baru kolomnya dijadikan AUTO_INCREMENT; akun baru melanjutkan dari angka terbesar.
ALTER TABLE `users` ADD COLUMN `customerSequence` INTEGER NULL;

UPDATE `users` u
  JOIN (SELECT `id`, ROW_NUMBER() OVER (ORDER BY `createdAt`, `id`) AS `n` FROM `users`) r ON r.`id` = u.`id`
  SET u.`customerSequence` = r.`n`;

ALTER TABLE `users` MODIFY `customerSequence` INTEGER NOT NULL AUTO_INCREMENT,
    ADD UNIQUE INDEX `users_customerSequence_key`(`customerSequence`);

-- AlterTable
ALTER TABLE `users` ADD COLUMN `memberPhotoPath` VARCHAR(191) NULL,
    ADD COLUMN `memberPhotoStatus` ENUM('pending', 'approved', 'rejected') NULL;

-- CreateIndex
CREATE INDEX `users_memberPhotoStatus_idx` ON `users`(`memberPhotoStatus`);
