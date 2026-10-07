import 'dotenv/config'
import { query } from '../src/config/database.js'

const settings = [
    // Payment
    ['razorpay_key_id', '""', 'Razorpay API Key ID'],
    ['razorpay_key_secret', '""', 'Razorpay API Secret (masked)'],
    ['cod_enabled', 'true', 'Cash on delivery enabled'],
    ['wallet_enabled', 'true', 'Wallet payments enabled'],
    ['wallet_min_recharge', '100', 'Min wallet recharge amount in Rs.'],
    ['wallet_max_balance', '10000', 'Max wallet balance in Rs.'],

    // Notifications
    ['sms_provider', '"MSG91"', 'SMS provider name'],
    ['sms_api_key', '""', 'SMS provider API key'],
    ['otp_sms_template', '"Your OTP is {otp}. Valid for {min} minutes."', 'OTP SMS template'],
    ['order_confirmed_sms', '"Your order #{id} has been confirmed!"', 'Order confirmed SMS template'],

    // Integrations
    ['google_maps_key', '""', 'Google Maps API key'],
    ['cloudinary_cloud_name', '""', 'Cloudinary cloud name'],
    ['firebase_enabled', 'false', 'Firebase push notifications enabled'],

    // Delivery Zones
    ['zone_1_name', '"Near Zone"', 'Zone 1 label'],
    ['zone_1_radius', '3', 'Zone 1 radius in km'],
    ['zone_1_fee', '20', 'Zone 1 delivery fee in Rs.'],
    ['zone_2_name', '"Mid Zone"', 'Zone 2 label'],
    ['zone_2_radius', '6', 'Zone 2 radius in km'],
    ['zone_2_fee', '35', 'Zone 2 delivery fee in Rs.'],
    ['zone_3_name', '"Far Zone"', 'Zone 3 label'],
    ['zone_3_radius', '10', 'Zone 3 radius in km'],
    ['zone_3_fee', '50', 'Zone 3 delivery fee in Rs.'],

    // Delivery Slots
    ['slot_1_label', '"Morning"', 'Slot 1 display label'],
    ['slot_1_start', '"08:00"', 'Slot 1 start time'],
    ['slot_1_end', '"12:00"', 'Slot 1 end time'],
    ['slot_2_label', '"Afternoon"', 'Slot 2 display label'],
    ['slot_2_start', '"12:00"', 'Slot 2 start time'],
    ['slot_2_end', '"17:00"', 'Slot 2 end time'],
    ['slot_3_label', '"Evening"', 'Slot 3 display label'],
    ['slot_3_start', '"17:00"', 'Slot 3 start time'],
    ['slot_3_end', '"21:00"', 'Slot 3 end time'],
    ['slot_enabled', 'true', 'Delivery time slots enabled'],

    // Backup & Data
    ['auto_backup_enabled', 'false', 'Automated database backups'],
    ['backup_frequency_hours', '24', 'Backup frequency in hours'],
    ['backup_retention_days', '30', 'Backup retention period in days'],
    ['backup_s3_bucket', '""', 'S3 bucket for backups'],
    ['data_export_enabled', 'true', 'Data export feature enabled'],

    // Branding
    ['logo_url', '""', 'Store logo URL'],
    ['favicon_url', '""', 'Favicon URL'],
    ['timezone', '"Asia/Kolkata"', 'Default timezone'],
    ['currency_code', '"INR"', 'Currency code'],
    ['currency_symbol', '"\\u20b9"', 'Currency display symbol'],

    // Email Templates
    ['email_from_address', '"noreply@bakaloo.com"', 'Outgoing email address'],
    ['email_from_name', '"Bakaloo"', 'Outgoing email display name'],
    ['email_welcome_subject', '"Welcome to Bakaloo!"', 'Welcome email subject'],
    ['email_order_confirm_subject', '"Your order has been confirmed"', 'Order confirmation subject'],
    ['email_delivery_subject', '"Your order is on the way!"', 'Delivery update subject'],
    ['email_smtp_host', '""', 'SMTP host'],
    ['email_smtp_port', '587', 'SMTP port'],
    ['email_smtp_user', '""', 'SMTP username'],
    ['email_smtp_password', '""', 'SMTP password'],
]

let inserted = 0
for (const [key, value, description] of settings) {
    const { rows } = await query('SELECT 1 FROM app_settings WHERE key = $1', [key])
    if (rows.length === 0) {
        await query(
            'INSERT INTO app_settings (key, value, description) VALUES ($1, $2::jsonb, $3)',
            [key, value, description]
        )
        inserted++
    }
}
console.log(`Inserted ${inserted} new settings`)

const { rows: total } = await query('SELECT COUNT(*)::int AS cnt FROM app_settings')
console.log(`Total settings now: ${total[0].cnt}`)

process.exit(0)
