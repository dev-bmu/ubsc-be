-- Tab Lunas antrean verifikasi pembayaran sekarang ter-paginasi (skip/take): urutan paidAt DESC,
-- receiptSequence DESC dibaca dari indeks alih-alih filesort seluruh transaksi PAID.

-- CreateIndex
CREATE INDEX `transactions_paymentStatus_paidAt_receiptSequence_idx` ON `transactions`(`paymentStatus`, `paidAt`, `receiptSequence`);
