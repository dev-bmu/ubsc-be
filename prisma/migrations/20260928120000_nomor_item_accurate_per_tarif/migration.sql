-- Nomor item Accurate berbeda per tarif (catatan client 2026-09-28): umum dan Warga UB, untuk fasilitas
-- dan paket membership. Transaksi mencatat tarif yang dipakai supaya export memilih nomor yang benar.
ALTER TABLE `facilities` ADD COLUMN `accurateItemNoWarga` VARCHAR(30) NULL;

ALTER TABLE `membership_plans` ADD COLUMN `accurateItemNoWarga` VARCHAR(30) NULL;

ALTER TABLE `transactions` ADD COLUMN `priceCategory` ENUM('warga_ub', 'umum') NOT NULL DEFAULT 'umum';

-- Isi baris lama secara perkiraan (tarifnya tidak pernah tercatat):
--  - membership: nominalnya sama dengan harga Warga UB paket (dan harga itu memang beda dari harga umum);
--  - booking: pemesan ber-akun yang identitas Warga UB-nya terverifikasi. Walk-in tetap umum.
UPDATE `transactions` t
JOIN `memberships` m ON m.`id` = t.`membershipId`
JOIN `membership_plans` p ON p.`id` = m.`membershipPlanId`
SET t.`priceCategory` = 'warga_ub'
WHERE p.`wargaPrice` IS NOT NULL AND p.`wargaPrice` <> p.`price` AND t.`amount` = p.`wargaPrice`;

UPDATE `transactions` t
JOIN `users` u ON u.`id` = t.`userId`
SET t.`priceCategory` = 'warga_ub'
WHERE t.`bookingId` IS NOT NULL AND u.`identityCategory` = 'warga_kampus' AND u.`identityStatus` = 'verified';
