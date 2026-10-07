-- 057_payment_method_settings.sql
-- Seed app_settings keys that gate payment methods (COD / Razorpay / Wallet)
-- and the COD minimum order amount. ON CONFLICT DO NOTHING so any value an
-- admin already saved via the dashboard is preserved.

INSERT INTO app_settings (key, value, description) VALUES
  ('cod_enabled',           'true', 'Cash on Delivery is offered at checkout'),
  ('razorpay_enabled',      'true', 'Online payment (Razorpay) is offered at checkout'),
  ('wallet_enabled',        'true', 'Bakaloo Wallet is offered at checkout'),
  ('cod_min_order_amount',  '99',   'Minimum bill amount (after fees) for Cash on Delivery to be offered')
ON CONFLICT (key) DO NOTHING;
