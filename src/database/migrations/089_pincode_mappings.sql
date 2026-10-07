-- 089_pincode_mappings.sql
--
-- Admin-curated pincode -> city/area/state overrides. Reverse-geocoding
-- (Nominatim/OSM, called directly from the Flutter app) is unreliable for
-- rural/small-town India — a real-world example: pincode 743287
-- (Chandpara, WB) and several Surat/Gujarat pincodes were coming back with
-- the wrong locality/city name from the public geocoder. Rather than trust
-- the geocoder for every pincode, an admin can add a handful of known-good
-- entries here; the customer app's /addresses/validate-pincode response
-- includes the mapped city/area/state whenever an ACTIVE match exists
-- (see addresses.service.js#validatePincode) and the Flutter address form
-- uses it to auto-fill City instead of leaving it to a guess. `is_active`
-- is the per-row toggle an admin uses to turn a specific override on/off
-- without deleting it.

CREATE TABLE IF NOT EXISTS pincode_mappings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  pincode               VARCHAR(10) NOT NULL,
  city                  VARCHAR(100) NOT NULL,
  area                  VARCHAR(150),
  state                 VARCHAR(100) NOT NULL,

  is_active             BOOLEAN NOT NULL DEFAULT true,

  created_by            UUID REFERENCES users(id),
  updated_by            UUID REFERENCES users(id),

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT chk_pincode_mappings_pincode CHECK (pincode ~ '^[1-9][0-9]{5}$')
);

-- One canonical mapping per pincode.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pincode_mappings_pincode
  ON pincode_mappings (pincode);

-- Fast lookup path used by validate-pincode (active rows only).
CREATE INDEX IF NOT EXISTS idx_pincode_mappings_active
  ON pincode_mappings (pincode)
  WHERE is_active = true;
