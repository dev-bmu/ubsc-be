-- SEO artikel + halaman statis landing (PRD tambahan §7.7). OG image keduanya = tabel media
-- (News koleksi 'og_image', PageSeo koleksi 'og_image'); gambar isi artikel = News koleksi 'content'.

-- AlterTable
ALTER TABLE `news` ADD COLUMN `metaDescription` VARCHAR(320) NULL,
    ADD COLUMN `metaTitle` VARCHAR(191) NULL,
    ADD COLUMN `noindex` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `page_seo` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `title` VARCHAR(191) NULL,
    `description` VARCHAR(320) NULL,
    `noindex` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `page_seo_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
