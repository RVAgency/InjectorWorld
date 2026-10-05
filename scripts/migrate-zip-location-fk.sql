-- ZIP <-> Location real FK (zip_codes and locations were only ever connected by a
-- runtime city/state string match, which silently breaks on spelling/casing drift).
-- Idempotent. Run against local and live DB before deploying.

-- 1. location_id column on zip_codes, pointing at the matching state/metro Location.
--    Nullable: APO/FPO/military and territory ZIPs (no US state) will never match.
ALTER TABLE "zip_codes" ADD COLUMN IF NOT EXISTS "location_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'zip_codes_location_id_locations_id_fk'
  ) THEN
    ALTER TABLE "zip_codes"
      ADD CONSTRAINT "zip_codes_location_id_locations_id_fk"
      FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "zip_codes_location_id_idx" ON "zip_codes" ("location_id");

-- 2. New DataAlert type for ZIP <-> city/state cross-validation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'enum_data_alerts_type' AND e.enumlabel = 'zip_location_mismatch'
  ) THEN
    ALTER TYPE "enum_data_alerts_type" ADD VALUE 'zip_location_mismatch';
  END IF;
EXCEPTION WHEN others THEN NULL;
END $$;

-- 3. Washington DC has no `state` Location row (locations only seeded the 50 states),
--    so every DC clinic fails both the state-level and city-level match. Add it.
--    (The one-off production location repair skipped DC for exactly this reason --
--    no parent state Location to attach to -- which is how this was found.)
INSERT INTO "locations" ("name", "slug", "kind", "state", "is_live", "noindex", "provider_count", "sort_rank", "featured", "updated_at", "created_at")
SELECT 'District of Columbia', 'district-of-columbia', 'state', 'DC', true, false, 0, 100, true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "locations" WHERE "kind" = 'state' AND "state" = 'DC'
);
