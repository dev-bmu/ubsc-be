-- AlterTable
ALTER TABLE `transactions` ADD COLUMN `adminFee` INTEGER NOT NULL DEFAULT 0;

-- Booking gratis dari meja depan dulu membuka transfer lalu langsung dilunasi, sehingga kode
-- uniknya tertinggal padahal tidak pernah ada uang yang ditransfer. Laporan keuangan kini
-- menghitung kode unik sebagai uang masuk, jadi sisa kode itu dibersihkan.
UPDATE `transactions` SET `uniqueCode` = NULL WHERE `amount` = 0 AND `pendingTotal` IS NULL;

-- Hanya transfer UNPAID yang perlu menahan nominalnya. Transaksi walk-in yang digagalkan saat
-- booking-nya dibatalkan dulu tetap menahan pendingTotal selamanya.
UPDATE `transactions` SET `pendingTotal` = NULL WHERE `paymentStatus` <> 'UNPAID' AND `pendingTotal` IS NOT NULL;
