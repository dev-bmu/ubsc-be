-- CreateTable
CREATE TABLE `booking_reschedules` (
    `id` VARCHAR(191) NOT NULL,
    `bookingId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `fromDate` DATE NOT NULL,
    `fromStartTime` VARCHAR(5) NOT NULL,
    `fromEndTime` VARCHAR(5) NOT NULL,
    `fromUnitName` VARCHAR(150) NULL,
    `toDate` DATE NOT NULL,
    `toStartTime` VARCHAR(5) NOT NULL,
    `toEndTime` VARCHAR(5) NOT NULL,
    `toUnitName` VARCHAR(150) NULL,
    `reason` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `booking_reschedules_bookingId_createdAt_idx`(`bookingId`, `createdAt`),
    INDEX `booking_reschedules_actorId_idx`(`actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Permission baru bookings.reschedule (shared/permissions.ts). Seeder menanganinya untuk database baru; di
-- database yang sudah berjalan tabel role_permissions adalah otoritas, jadi tautannya ditambah di sini.
INSERT INTO `permissions` (`id`, `code`, `name`, `description`, `createdAt`, `updatedAt`)
SELECT UUID(), 'bookings.reschedule', 'Ubah Jadwal Reservasi',
       'Memindahkan tanggal/jam/unit reservasi lapangan & kelas',
       NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `code` = 'bookings.reschedule');

-- Hanya role yang SUDAH punya baris di role_permissions. Role tanpa baris memakai fallback
-- shared/permissions.ts (yang sudah memuat bookings.reschedule); memberinya satu baris di sini justru akan
-- menjadikan bookings.reschedule satu-satunya permission role itu. Dan hanya role yang MASIH punya akses
-- reservasi: bookings.reschedule membuka daftar booking, jadi role yang sengaja dipangkas Administrator
-- dari reservasi tidak boleh mendapatkannya kembali diam-diam saat deploy.
INSERT INTO `role_permissions` (`id`, `roleName`, `permissionId`, `createdAt`, `updatedAt`)
SELECT UUID(), rn.`roleName`, p.`id`, NOW(3), NOW(3)
FROM (
    SELECT DISTINCT `roleName` FROM `role_permissions`
    WHERE `roleName` IN ('Manager', 'Staff Central', 'Staff Front Office')
) rn
JOIN `permissions` p ON p.`code` = 'bookings.reschedule'
WHERE NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`roleName` = rn.`roleName` AND rp.`permissionId` = p.`id`
)
AND EXISTS (
    SELECT 1 FROM `role_permissions` r2 JOIN `permissions` p2 ON p2.`id` = r2.`permissionId`
    WHERE r2.`roleName` = rn.`roleName` AND p2.`code` IN ('bookings.read', 'bookings.manage')
);
