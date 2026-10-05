-- Nomor invoice 'UBSC-<bulan romawi>-<tahun>-<urutan 4 digit>', urutan direset tiap tahun WIB
-- (permintaan client 2026-10-01). Ditulis tangan: kolom NOT NULL + UNIQUE butuh pengisian baris lama
-- dulu, dan counter per tahun harus melanjutkan dari nomor terakhir yang sudah terbit.

CREATE TABLE `invoice_counters` (
    `year` INTEGER NOT NULL,
    `lastSeq` INTEGER NOT NULL,
    PRIMARY KEY (`year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `transactions` ADD COLUMN `invoiceNumber` VARCHAR(30) NULL;

-- Baris lama: urut waktu dibuat (WIB = UTC+7) per tahun.
UPDATE `transactions` t
JOIN (
    SELECT `id`,
           YEAR(DATE_ADD(`createdAt`, INTERVAL 7 HOUR)) AS y,
           MONTH(DATE_ADD(`createdAt`, INTERVAL 7 HOUR)) AS m,
           ROW_NUMBER() OVER (PARTITION BY YEAR(DATE_ADD(`createdAt`, INTERVAL 7 HOUR)) ORDER BY `createdAt`, `receiptSequence`) AS seq
    FROM `transactions`
) n ON n.`id` = t.`id`
SET t.`invoiceNumber` = CONCAT(
    'UBSC-',
    ELT(n.m, 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'),
    '-', n.y, '-',
    IF(n.seq > 9999, n.seq, LPAD(n.seq, 4, '0'))
);

INSERT INTO `invoice_counters` (`year`, `lastSeq`)
SELECT YEAR(DATE_ADD(`createdAt`, INTERVAL 7 HOUR)), COUNT(*) FROM `transactions` GROUP BY 1;

ALTER TABLE `transactions` MODIFY `invoiceNumber` VARCHAR(30) NOT NULL;

CREATE UNIQUE INDEX `transactions_invoiceNumber_key` ON `transactions`(`invoiceNumber`);
