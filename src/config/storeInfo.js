import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Registered business details printed on every invoice / packing slip.
 */
export const STORE_INFO = {
  name: 'FreshCuts',
  // ⚠ Still the leftover "Bakaloo"/Surat business-registration details from
  // before the FreshCuts rebrand — genuinely wrong on every real invoice/
  // packing slip printed today, but these are legal/compliance fields
  // (GST registration, registered address) that must come from the user's
  // real business records, never guessed. Replace with FreshCuts' actual
  // registered address, GST number, and support phone.
  addressLines: [
    'Shop No. 27, Khari Faliyu, Ananddhara V-2 Road,',
    'Opp. Rudraksh Residency, Ramchowk, Mota Varachha,',
    'Surat - 394101, Gujarat',
  ],
  gstNo: '24ABFFB1171P1ZD',
  phone: '+91 99249 90627',
  logoPath: path.join(__dirname, '..', 'assets', 'freshcuts-logo.png'),
  // PDFKit's standard 14 fonts (Helvetica etc.) have no ₹ glyph — they mangle
  // it into a stray "1"-like symbol. This variable font (already used by the
  // dashboard, OFL-licensed) does, so it's the font for any text with a ₹.
  currencyFontPath: path.join(__dirname, '..', 'assets', 'GeistVF.woff'),
}
