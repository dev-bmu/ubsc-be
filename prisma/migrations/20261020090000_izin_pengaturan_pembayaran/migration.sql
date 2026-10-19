-- Permission baru payments.settings.manage (shared/permissions.ts): Pengaturan Pembayaran (rekening, durasi hold,
-- kode unik, QRIS, kode Accurate) dipisah dari payments.manage. Keputusan client 2026-10-20: default HANYA
-- Administrator, yang mem-bypass seluruh pengecekan permission — jadi tidak ada tautan role yang ditambahkan di sini.
-- Role lain (mis. Manager/Finance) diberi lewat layar Role & Access bila perlu.
INSERT INTO `permissions` (`id`, `code`, `name`, `description`, `createdAt`, `updatedAt`)
SELECT UUID(), 'payments.settings.manage', 'Kelola Pengaturan Pembayaran',
       'Mengubah durasi hold, kode unik, QRIS, rekening, dan kode Accurate di Pengaturan Pembayaran',
       NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `code` = 'payments.settings.manage');
