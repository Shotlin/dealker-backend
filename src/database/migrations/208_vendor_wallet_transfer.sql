-- Vendor → Dealker wallet transfer (settlement earnings fund auction fees / winning payments)
ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_tx_sub_type;
ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_tx_sub_type CHECK (
  sub_type IS NULL OR sub_type IN (
    'REFUND', 'BONUS', 'SCRATCH', 'CASHBACK', 'ORDER', 'TOPUP', 'AUCTION_FEE', 'AUCTION_REFUND', 'SELL_PAYOUT', 'VENDOR_TRANSFER')
);
