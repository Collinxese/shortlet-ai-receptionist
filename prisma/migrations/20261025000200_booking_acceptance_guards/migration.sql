-- Preserve historical migrations. Fix normalization and bind SQL guards to the
-- schema they protect, including for qualified SQL with another search_path.
BEGIN;
LOCK TABLE "Property", "Booking", "AvailabilityBlock" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION booking_phone(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN cleaned ~ '^0[0-9]{10}$' THEN '+234' || substring(cleaned FROM 2) ELSE cleaned END
    FROM (
      -- Exactly the boundary whitespace accepted by JavaScript String.trim().
      -- Internal spaces/parentheses/hyphens retain the existing API semantics.
      SELECT regexp_replace(btrim(value,
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),
        '[ ()-]', '', 'g') AS cleaned
    ) normalized
  $$;

DO $$
DECLARE routine text; arguments text; protected_schema text := current_schema();
BEGIN
  FOREACH routine IN ARRAY ARRAY['booking_day', 'booking_phone', 'protect_booking_terms', 'guard_booking_occupancy', 'guard_block_occupancy']
  LOOP
    arguments := CASE routine WHEN 'booking_day' THEN 'timestamp without time zone'
      WHEN 'booking_phone' THEN 'text' ELSE '' END;
    -- Core functions first; protected tables before caller temporary tables.
    -- Remain SECURITY INVOKER: this grants no additional database privileges.
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path TO pg_catalog, %I, pg_temp',
      protected_schema, routine, arguments, protected_schema);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM "Booking"
    WHERE status = 'HELD' AND ("holdExpiresAt" IS NULL OR "holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))
    GROUP BY "tenantId", booking_phone("guestPhone") HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Phase 3 acceptance: resolve duplicate active guest holds after whitespace normalization';
  END IF;
END $$;
COMMIT;
