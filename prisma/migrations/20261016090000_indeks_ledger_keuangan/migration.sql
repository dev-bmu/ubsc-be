-- Ledger keuangan ter-paginasi per rentang tanggal (GET /api/admin/finance/ledger). Jalur default
-- (basis tanggal transaksi, semua status): createdAt di rentang, urut createdAt DESC, receiptSequence DESC
-- dibaca dari indeks alih-alih full scan + filesort seluruh transaksi.

-- CreateIndex
CREATE INDEX `transactions_createdAt_receiptSequence_idx` ON `transactions`(`createdAt`, `receiptSequence`);
