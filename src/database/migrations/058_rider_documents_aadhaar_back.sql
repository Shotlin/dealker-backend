-- Allow 'aadhaar_back' as a separate doc_type so the rider app can
-- upload the Aadhaar back side without violating the doc_type CHECK
-- constraint. The constraint previously only allowed
-- ('aadhaar', 'license', 'vehicle_rc', 'pan', 'photo', 'bank_proof'),
-- so every "Aadhaar back" upload failed with a constraint violation.

ALTER TABLE rider_documents DROP CONSTRAINT IF EXISTS rider_documents_doc_type_check;

ALTER TABLE rider_documents ADD CONSTRAINT rider_documents_doc_type_check
  CHECK (doc_type IN ('aadhaar', 'aadhaar_back', 'license', 'vehicle_rc', 'pan', 'photo', 'bank_proof'));
