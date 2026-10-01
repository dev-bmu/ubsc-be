-- CreateTable
CREATE TABLE `gym_visits` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `membershipId` VARCHAR(191) NOT NULL,
    `visitDate` DATE NOT NULL,
    `checkedInAt` DATETIME(3) NOT NULL,
    `checkedInById` VARCHAR(191) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `isOverride` BOOLEAN NOT NULL DEFAULT false,
    `overrideReason` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `gym_visits_visitDate_idx`(`visitDate`),
    INDEX `gym_visits_userId_visitDate_idx`(`userId`, `visitDate`),
    INDEX `gym_visits_checkedInAt_idx`(`checkedInAt`),
    INDEX `gym_visits_membershipId_idx`(`membershipId`),
    INDEX `gym_visits_checkedInById_idx`(`checkedInById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Permission baru gym.checkin (shared/permissions.ts). Seeder menanganinya untuk database baru; di
-- database yang sudah berjalan tabel role_permissions adalah otoritas, jadi tautannya ditambah di sini.
INSERT INTO `permissions` (`id`, `code`, `name`, `description`, `createdAt`, `updatedAt`)
SELECT UUID(), 'gym.checkin', 'Check-in Gym',
       'Mencatat kehadiran member di meja gym (termasuk mengizinkan masuk ulang dengan alasan) dan melihat analitik kunjungan',
       NOW(3), NOW(3)
WHERE NOT EXISTS (SELECT 1 FROM `permissions` WHERE `code` = 'gym.checkin');

-- Hanya role yang SUDAH punya baris di role_permissions. Role tanpa baris memakai fallback
-- shared/permissions.ts (yang sudah memuat gym.checkin); memberinya satu baris di sini justru akan
-- menjadikan gym.checkin satu-satunya permission role itu.
INSERT INTO `role_permissions` (`id`, `roleName`, `permissionId`, `createdAt`, `updatedAt`)
SELECT UUID(), rn.`roleName`, p.`id`, NOW(3), NOW(3)
FROM (
    SELECT DISTINCT `roleName` FROM `role_permissions`
    WHERE `roleName` IN ('Manager', 'Staff Central', 'Staff Front Office')
) rn
JOIN `permissions` p ON p.`code` = 'gym.checkin'
WHERE NOT EXISTS (
    SELECT 1 FROM `role_permissions` rp WHERE rp.`roleName` = rn.`roleName` AND rp.`permissionId` = p.`id`
);
