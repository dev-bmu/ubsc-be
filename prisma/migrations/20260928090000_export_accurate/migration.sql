-- Export Accurate (PRD tambahan 2026-09, bagian 6): nomor barang/jasa Accurate per fasilitas dan per
-- paket membership, dan ID pelanggan Accurate 'WEB.0001' yang terbit saat pelanggan pertama kali
-- masuk export faktur.
ALTER TABLE `facilities` ADD COLUMN `accurateItemNo` VARCHAR(30) NULL;

ALTER TABLE `membership_plans` ADD COLUMN `accurateItemNo` VARCHAR(30) NULL;

ALTER TABLE `users` ADD COLUMN `accurateSequence` INTEGER NULL;

CREATE UNIQUE INDEX `users_accurateSequence_key` ON `users`(`accurateSequence`);
