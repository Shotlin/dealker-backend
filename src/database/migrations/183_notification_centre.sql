-- 183_notification_centre.sql
-- Central notification centre. Alerts are raised by database triggers, so
-- every writer is covered (API, workers, imports) and the alert commits
-- atomically with the event. Each alert type can be switched off, given a
-- severity and an amount threshold under Notification Control
-- (alert_settings). A failing alert never blocks the original write.

CREATE TABLE IF NOT EXISTS alert_settings (
  type TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  grp TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  min_amount NUMERIC(12,2) CHECK (min_amount IS NULL OR min_amount >= 0),   -- only for alerts that carry an amount
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO alert_settings (type, label, grp, severity, min_amount, sort_order) VALUES
  ('NEW_ORDER',             'New order',                 'Orders & payments', 'INFO',     NULL, 1),
  ('ORDER_CANCELLED',       'Order cancelled',           'Orders & payments', 'WARNING',  NULL, 2),
  ('PAYMENT_RECEIVED',      'Payment received',          'Orders & payments', 'INFO',     NULL, 3),
  ('REFUND_REQUEST',        'Refund request',            'Orders & payments', 'WARNING',  NULL, 4),
  ('EXCHANGE_REQUEST',      'Exchange request',          'Orders & payments', 'INFO',     NULL, 5),
  ('SELL_REQUEST',          'Sell-on-phone lead',        'Orders & payments', 'INFO',     NULL, 6),
  ('AUCTION_STARTED',       'Auction started',           'Auctions',          'INFO',     NULL, 10),
  ('AUCTION_ENDING',        'Auction ending soon',       'Auctions',          'WARNING',  NULL, 11),
  ('AUCTION_WON',           'Auction won',               'Auctions',          'INFO',     NULL, 12),
  ('CAMPAIGN_PURCHASED',    'Campaign purchased',        'Marketing',         'INFO',     NULL, 20),
  ('PRODUCT_APPROVED',      'Product approved',          'Catalogue',         'INFO',     NULL, 30),
  ('PRODUCT_REJECTED',      'Product rejected',          'Catalogue',         'WARNING',  NULL, 31),
  ('QC_FAILED',             'QC failed',                 'Catalogue',         'WARNING',  NULL, 32),
  ('LOW_STOCK',             'Low stock',                 'Catalogue',         'WARNING',  NULL, 33),
  ('NEW_REVIEW',            'New review',                'Catalogue',         'INFO',     NULL, 34),
  ('NEW_VENDOR',            'New vendor',                'People',            'INFO',     NULL, 40),
  ('NEW_CUSTOMER',          'New customer',              'People',            'INFO',     NULL, 41),
  ('SUBSCRIPTION_EXPIRING', 'Subscription expiring',     'People',            'WARNING',  NULL, 42),
  ('SUBSCRIPTION_EXPIRED',  'Subscription expired',      'People',            'WARNING',  NULL, 43),
  ('WALLET_CREDIT',         'Wallet credit',             'Wallets',           'INFO',     500,  50),
  ('WALLET_DEBIT',          'Wallet debit',              'Wallets',           'INFO',     500,  51),
  ('DELIVERY_FAILED',       'Delivery failed',           'Shipping & support','CRITICAL', NULL, 60),
  ('RTO',                   'Returned to origin (RTO)',  'Shipping & support','WARNING',  NULL, 61),
  ('NEW_SUPPORT_TICKET',    'New support ticket',        'Shipping & support','INFO',     NULL, 62)
ON CONFLICT (type) DO NOTHING;

CREATE OR REPLACE FUNCTION rank(sev TEXT) RETURNS INTEGER AS $fn$
  SELECT CASE sev WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'INFO' THEN 1 ELSE 0 END
$fn$ LANGUAGE sql IMMUTABLE;

-- Single entry point used by every trigger below.
CREATE OR REPLACE FUNCTION emit_admin_alert(
  p_type TEXT, p_title TEXT, p_body TEXT, p_entity_type TEXT, p_entity_id TEXT,
  p_link TEXT, p_dedupe TEXT, p_amount NUMERIC DEFAULT NULL, p_severity TEXT DEFAULT NULL
) RETURNS VOID AS $fn$
DECLARE s alert_settings%ROWTYPE; sev TEXT;
BEGIN
  SELECT * INTO s FROM alert_settings WHERE type = p_type;
  IF FOUND THEN
    IF NOT s.enabled THEN RETURN; END IF;
    IF s.min_amount IS NOT NULL AND p_amount IS NOT NULL AND p_amount < s.min_amount THEN RETURN; END IF;
  END IF;
  -- the configured severity is the base; an event may escalate it (e.g. a 1-star review), never lower it
  sev := CASE WHEN rank(p_severity) > rank(COALESCE(s.severity, 'INFO')) THEN p_severity ELSE COALESCE(s.severity, 'INFO') END;
  INSERT INTO admin_alerts (type, severity, title, body, entity_type, entity_id, link, dedupe_key)
  VALUES (p_type, sev, p_title, p_body, p_entity_type, p_entity_id, p_link, p_dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  NULL;  -- an alert must never break the write that raised it
END
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fmt_inr(n NUMERIC) RETURNS TEXT AS $fn$
  SELECT '₹' || to_char(ROUND(COALESCE(n, 0)), 'FM99,99,99,999')
$fn$ LANGUAGE sql IMMUTABLE;

-- ── Orders ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_order_insert() RETURNS TRIGGER AS $fn$
BEGIN
  PERFORM emit_admin_alert('NEW_ORDER',
    'New order ' || NEW.order_number || ' · ' || fmt_inr(COALESCE(NEW.total_payable,0) + COALESCE(NEW.wallet_amount,0) + COALESCE(NEW.loyalty_redeemed_amount,0)),
    (SELECT COALESCE(name, phone) FROM users WHERE id = NEW.customer_id) || ' · ' || COALESCE(NEW.payment_method, ''),
    'order', NEW.id::text, '/orders/' || NEW.id, 'order:' || NEW.id);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_order_insert ON orders;
CREATE TRIGGER trg_alert_order_insert AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION trg_alert_order_insert();

CREATE OR REPLACE FUNCTION trg_alert_order_update() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
    PERFORM emit_admin_alert('ORDER_CANCELLED', 'Order ' || NEW.order_number || ' cancelled',
      (SELECT COALESCE(name, phone) FROM users WHERE id = NEW.customer_id), 'order', NEW.id::text, '/orders/' || NEW.id, 'order-cancel:' || NEW.id);
  END IF;
  IF NEW.payment_status IN ('PAID', 'PARTIALLY_PAID') AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    PERFORM emit_admin_alert('PAYMENT_RECEIVED',
      'Payment received · ' || NEW.order_number || ' · ' || fmt_inr(NEW.amount_paid),
      CASE WHEN NEW.payment_status = 'PARTIALLY_PAID' THEN 'Advance paid, ' || fmt_inr(NEW.amount_due) || ' due on delivery' ELSE 'Paid in full' END,
      'order', NEW.id::text, '/orders/' || NEW.id, 'pay:' || NEW.id || ':' || NEW.payment_status, NEW.amount_paid);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_order_update ON orders;
CREATE TRIGGER trg_alert_order_update AFTER UPDATE OF status, payment_status ON orders FOR EACH ROW EXECUTE FUNCTION trg_alert_order_update();

-- ── Refunds, exchanges, sell leads ────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_refund_insert() RETURNS TRIGGER AS $fn$
BEGIN
  PERFORM emit_admin_alert('REFUND_REQUEST', 'Refund requested · ' || fmt_inr(NEW.computed_amount),
    LEFT(NEW.reason, 140), 'refund', NEW.id::text, '/refund-requests/' || NEW.id, 'refund:' || NEW.id, NEW.computed_amount);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_refund_insert ON refund_requests;
CREATE TRIGGER trg_alert_refund_insert AFTER INSERT ON refund_requests FOR EACH ROW EXECUTE FUNCTION trg_alert_refund_insert();

CREATE OR REPLACE FUNCTION trg_alert_sell_insert() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.kind = 'EXCHANGE' THEN
    PERFORM emit_admin_alert('EXCHANGE_REQUEST', 'Exchange request ' || NEW.code || ' · ' || NEW.model_name,
      NEW.customer_name || ' · quote ' || fmt_inr(NEW.quote), 'exchange', NEW.id::text, '/exchange-requests', 'exchange:' || NEW.id, NEW.quote);
  ELSE
    PERFORM emit_admin_alert('SELL_REQUEST', 'Sell lead ' || NEW.code || ' · ' || NEW.model_name,
      NEW.customer_name || ' · quote ' || fmt_inr(NEW.quote), 'sell', NEW.id::text, '/sell-requests', 'sell:' || NEW.id, NEW.quote);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_sell_insert ON sell_requests;
CREATE TRIGGER trg_alert_sell_insert AFTER INSERT ON sell_requests FOR EACH ROW EXECUTE FUNCTION trg_alert_sell_insert();

-- ── Auctions ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_auction_update() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.status = 'LIVE' AND OLD.status IS DISTINCT FROM 'LIVE' THEN
    PERFORM emit_admin_alert('AUCTION_STARTED', 'Auction ' || NEW.auction_number || ' is live', NEW.title, 'auction', NEW.id::text, '/auctions/' || NEW.id, 'auction-live:' || NEW.id);
  END IF;
  IF NEW.winner_id IS NOT NULL AND OLD.winner_id IS DISTINCT FROM NEW.winner_id THEN
    PERFORM emit_admin_alert('AUCTION_WON', 'Auction ' || NEW.auction_number || ' won · ' || fmt_inr(NEW.current_price),
      (SELECT COALESCE(name, phone) FROM users WHERE id = NEW.winner_id) || ' · ' || NEW.title, 'auction', NEW.id::text, '/auctions/' || NEW.id, 'auction-won:' || NEW.id || ':' || NEW.winner_id);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_auction_update ON auctions;
CREATE TRIGGER trg_alert_auction_update AFTER UPDATE OF status, winner_id ON auctions FOR EACH ROW EXECUTE FUNCTION trg_alert_auction_update();

-- ── Ad campaigns bought by vendors ────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_adcampaign() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.status = 'PENDING_REVIEW' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM emit_admin_alert('CAMPAIGN_PURCHASED', 'Ad campaign ' || NEW.campaign_number || ' submitted',
      (SELECT name FROM vendors WHERE id = NEW.vendor_id) || ' · daily budget ' || fmt_inr(NEW.daily_budget),
      'ad_campaign', NEW.id::text, '/ads/' || NEW.id, 'adcamp:' || NEW.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint, NEW.daily_budget);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_adcampaign ON ad_campaigns;
CREATE TRIGGER trg_alert_adcampaign AFTER INSERT OR UPDATE OF status ON ad_campaigns FOR EACH ROW EXECUTE FUNCTION trg_alert_adcampaign();

-- ── Catalogue: approval, QC, stock, reviews ───────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_listing_update() RETURNS TRIGGER AS $fn$
DECLARE pname TEXT;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT name INTO pname FROM products WHERE id = NEW.product_id;
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    IF NEW.approval_status = 'APPROVED' THEN
      PERFORM emit_admin_alert('PRODUCT_APPROVED', 'Product approved · ' || pname, NULL, 'listing', NEW.id::text, '/products', 'prod-ok:' || NEW.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint);
    ELSIF NEW.approval_status = 'REJECTED' THEN
      PERFORM emit_admin_alert('PRODUCT_REJECTED', 'Product sent back · ' || pname, LEFT(NEW.rejection_reason, 140), 'listing', NEW.id::text, '/products', 'prod-no:' || NEW.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint);
    END IF;
  END IF;
  IF NEW.qc_status = 'QC_FAILED' AND OLD.qc_status IS DISTINCT FROM 'QC_FAILED' THEN
    PERFORM emit_admin_alert('QC_FAILED', 'QC failed · ' || pname, LEFT(NEW.qc_notes, 140), 'listing', NEW.id::text, '/qc', 'qc-fail:' || NEW.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint);
  END IF;
  IF NEW.stock_quantity < OLD.stock_quantity AND NEW.stock_quantity <= NEW.low_stock_threshold AND OLD.stock_quantity > NEW.low_stock_threshold THEN
    PERFORM emit_admin_alert('LOW_STOCK',
      CASE WHEN NEW.stock_quantity = 0 THEN 'Out of stock · ' ELSE 'Low stock · ' END || pname,
      NEW.stock_quantity || ' left (alert at ' || NEW.low_stock_threshold || ')', 'listing', NEW.id::text, '/products', 'low-stock:' || NEW.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_listing_update ON shop_products;
CREATE TRIGGER trg_alert_listing_update AFTER UPDATE OF approval_status, qc_status, stock_quantity ON shop_products FOR EACH ROW EXECUTE FUNCTION trg_alert_listing_update();

CREATE OR REPLACE FUNCTION trg_alert_review_insert() RETURNS TRIGGER AS $fn$
BEGIN
  PERFORM emit_admin_alert('NEW_REVIEW', 'New ' || NEW.rating || '★ review · ' || (SELECT name FROM products WHERE id = NEW.product_id),
    LEFT(NEW.comment, 140), 'review', NEW.id::text, '/reviews', 'review:' || NEW.id, NULL, CASE WHEN NEW.rating <= 2 THEN 'WARNING' ELSE 'INFO' END);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_review_insert ON reviews;
CREATE TRIGGER trg_alert_review_insert AFTER INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION trg_alert_review_insert();

-- ── People ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_vendor_insert() RETURNS TRIGGER AS $fn$
BEGIN
  PERFORM emit_admin_alert('NEW_VENDOR', 'New vendor · ' || NEW.name, NEW.email, 'vendor', NEW.id::text, '/vendors', 'vendor:' || NEW.id);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_vendor_insert ON vendors;
CREATE TRIGGER trg_alert_vendor_insert AFTER INSERT ON vendors FOR EACH ROW EXECUTE FUNCTION trg_alert_vendor_insert();

CREATE OR REPLACE FUNCTION trg_alert_customer_insert() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.role = 'CUSTOMER' THEN
    PERFORM emit_admin_alert('NEW_CUSTOMER', 'New customer · ' || COALESCE(NEW.name, NEW.phone), NEW.phone, 'user', NEW.id::text, '/customers', 'customer:' || NEW.id);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_customer_insert ON users;
CREATE TRIGGER trg_alert_customer_insert AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION trg_alert_customer_insert();

-- ── Wallets ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_wallet_txn() RETURNS TRIGGER AS $fn$
DECLARE who TEXT;
BEGIN
  SELECT COALESCE(u.name, u.phone) INTO who FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.id = NEW.wallet_id;
  PERFORM emit_admin_alert(CASE WHEN NEW.type::text = 'CREDIT' THEN 'WALLET_CREDIT' ELSE 'WALLET_DEBIT' END,
    'Customer wallet ' || CASE WHEN NEW.type::text = 'CREDIT' THEN 'credited ' ELSE 'debited ' END || fmt_inr(NEW.amount),
    who || ' · ' || LEFT(COALESCE(NEW.description, ''), 100), 'wallet', NEW.id::text, '/wallet', 'wtx:' || NEW.id, NEW.amount);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_wallet_txn ON wallet_transactions;
CREATE TRIGGER trg_alert_wallet_txn AFTER INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION trg_alert_wallet_txn();

-- Vendor wallet: only admin entries, payouts, penalties, bonuses — not the per-order postings.
CREATE OR REPLACE FUNCTION trg_alert_vendor_ledger() RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.reference_type = 'ADMIN_MANUAL' OR NEW.entry_type IN ('PAYOUT', 'PENALTY', 'BONUS', 'SETTLEMENT') THEN
    PERFORM emit_admin_alert(CASE WHEN NEW.amount > 0 THEN 'WALLET_CREDIT' ELSE 'WALLET_DEBIT' END,
      'Vendor wallet ' || CASE WHEN NEW.amount > 0 THEN 'credited ' ELSE 'debited ' END || fmt_inr(ABS(NEW.amount)),
      (SELECT name FROM vendors WHERE id = NEW.vendor_id) || ' · ' || COALESCE(NEW.reason_code, NEW.entry_type),
      'vendor', NEW.vendor_id::text, '/vendor-wallet', 'vled:' || NEW.id, ABS(NEW.amount));
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_vendor_ledger ON settlement_ledger;
CREATE TRIGGER trg_alert_vendor_ledger AFTER INSERT ON settlement_ledger FOR EACH ROW EXECUTE FUNCTION trg_alert_vendor_ledger();

-- ── Shipping & support ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_alert_shipment_event() RETURNS TRIGGER AS $fn$
DECLARE ref TEXT; oid UUID;
BEGIN
  IF NEW.status IN ('FAILED', 'RTO') THEN
    SELECT so.seller_order_number, so.order_id INTO ref, oid FROM shipments s JOIN seller_orders so ON so.id = s.seller_order_id WHERE s.id = NEW.shipment_id;
    PERFORM emit_admin_alert(CASE WHEN NEW.status = 'RTO' THEN 'RTO' ELSE 'DELIVERY_FAILED' END,
      CASE WHEN NEW.status = 'RTO' THEN 'Returning to seller (RTO) · ' ELSE 'Delivery failed · ' END || COALESCE(ref, 'shipment'),
      LEFT(NEW.note, 140), 'shipment', NEW.shipment_id::text, CASE WHEN oid IS NOT NULL THEN '/orders/' || oid ELSE '/shipments' END, 'ship:' || NEW.id);
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_shipment_event ON shipment_events;
CREATE TRIGGER trg_alert_shipment_event AFTER INSERT ON shipment_events FOR EACH ROW EXECUTE FUNCTION trg_alert_shipment_event();

CREATE OR REPLACE FUNCTION trg_alert_ticket_insert() RETURNS TRIGGER AS $fn$
BEGIN
  PERFORM emit_admin_alert('NEW_SUPPORT_TICKET', 'New support ticket ' || NEW.ticket_number, LEFT(NEW.subject, 140), 'ticket', NEW.id::text, '/support', 'ticket:' || NEW.id);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_alert_ticket_insert ON support_tickets;
CREATE TRIGGER trg_alert_ticket_insert AFTER INSERT ON support_tickets FOR EACH ROW EXECUTE FUNCTION trg_alert_ticket_insert();

-- ── Permissions ───────────────────────────────────────────────────────────
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['alerts.view'])))
   )
 WHERE name IN ('Platform Admin', 'Finance Manager', 'Marketing Manager', 'Catalog Manager', 'Support Agent');
UPDATE roles
   SET permissions = (
     SELECT to_jsonb(ARRAY(SELECT DISTINCT p FROM jsonb_array_elements_text(roles.permissions) p
       UNION SELECT unnest(ARRAY['alerts.manage'])))
   )
 WHERE name = 'Platform Admin';
