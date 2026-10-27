-- Do not repair or discard ambiguous legacy reservations automatically.
BEGIN;
LOCK TABLE "Property", "Booking", "AvailabilityBlock" IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION booking_day(value timestamp) RETURNS timestamp
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT date_trunc('day', value + interval '1 hour') - interval '1 hour'
  $$;
CREATE FUNCTION booking_phone(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT CASE WHEN cleaned ~ '^0[0-9]{10}$' THEN '+234' || substring(cleaned FROM 2) ELSE cleaned END
    FROM (SELECT regexp_replace(value, '[ ()-]', '', 'g') AS cleaned) normalized
  $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Booking" WHERE booking_day("checkIn") >= booking_day("checkOut")
    OR "guestCount" < 1 OR "quoteTotalKobo" < 0 OR currency <> 'NGN'
    OR (status = 'HELD' AND "holdExpiresAt" IS NULL)) THEN
    RAISE EXCEPTION 'Phase 3: repair invalid legacy booking dates, amounts, capacity, currency or missing hold expiry';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" a JOIN "Booking" b
    ON a."tenantId" = b."tenantId" AND a.id < b.id
    WHERE (a.status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING') OR
      (a.status = 'HELD' AND a."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')))
    AND (b.status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING') OR
      (b.status = 'HELD' AND b."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')))
    AND ((a."propertyId" = b."propertyId" AND
      tsrange(booking_day(a."checkIn"), booking_day(a."checkOut"), '[)') &&
      tsrange(booking_day(b."checkIn"), booking_day(b."checkOut"), '[)')) OR
      (a.status = 'HELD' AND b.status = 'HELD' AND booking_phone(a."guestPhone") = booking_phone(b."guestPhone")))) THEN
    RAISE EXCEPTION 'Phase 3: resolve overlapping legacy bookings or duplicate active guest holds';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" b JOIN "AvailabilityBlock" c
    ON b."tenantId" = c."tenantId" AND b."propertyId" = c."propertyId"
    WHERE (b.status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING') OR
      (b.status = 'HELD' AND b."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')))
    AND tsrange(booking_day(b."checkIn"), booking_day(b."checkOut"), '[)') && tsrange(c."startDate", c."endDate", '[)')) THEN
    RAISE EXCEPTION 'Phase 3: resolve legacy booking/calendar block conflicts';
  END IF;
END $$;

ALTER TABLE "Booking" ADD COLUMN reference TEXT,
  ADD COLUMN "holdStartedAt" TIMESTAMP(3),
  ADD COLUMN "holdExtensionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quoteSnapshot" JSONB;
-- Legacy terms remain explicitly unknown; do not fabricate itemized prices.
UPDATE "Booking" SET reference = 'LEGACY-' || id;
ALTER TABLE "Booking" ALTER COLUMN reference SET NOT NULL;
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking" (reference);
CREATE UNIQUE INDEX "Booking_tenantId_id_key" ON "Booking" ("tenantId", id);
CREATE INDEX "Booking_tenantId_propertyId_status_holdExpiresAt_idx"
  ON "Booking" ("tenantId", "propertyId", status, "holdExpiresAt");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_values_check" CHECK (
  booking_day("checkIn") < booking_day("checkOut") AND "guestCount" >= 1
  AND "quoteTotalKobo" >= 0 AND currency = 'NGN' AND "holdExtensionCount" BETWEEN 0 AND 1
  AND (status <> 'HELD' OR "holdExpiresAt" IS NOT NULL)
  AND ("quoteSnapshot" IS NULL OR (jsonb_typeof("quoteSnapshot") = 'object'
    AND "quoteTotalKobo" > 0 AND "quoteTotalKobo" <= 9007199254740991
    AND "guestCount" <= 1000 AND char_length(btrim("guestName")) BETWEEN 1 AND 120 AND "guestName" IS NOT NULL
    AND "guestPhone" ~ '^\+[1-9][0-9]{7,14}$'
    AND "checkIn" = booking_day("checkIn") AND "checkOut" = booking_day("checkOut")
    AND "checkOut" - "checkIn" <= interval '366 days'
    AND (status <> 'HELD' OR ("holdStartedAt" IS NOT NULL
      AND "holdExpiresAt" > "holdStartedAt"
      AND "holdExpiresAt" = "holdStartedAt" + (60 + 15 * "holdExtensionCount") * interval '1 minute'))))
);
-- Time-dependent holds cannot use an immutable exclusion predicate. Durable
-- occupancy has an exclusion; expiring holds and cross-table conflicts use the
-- shared locking triggers below (READ COMMITTED fresh statement snapshots).
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_durable_no_overlap" EXCLUDE USING gist (
  "tenantId" public.gist_text_ops WITH =, "propertyId" public.gist_text_ops WITH =,
  tsrange(booking_day("checkIn"), booking_day("checkOut"), '[)') WITH &&
) WHERE (status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING'));

CREATE TABLE "BookingOperation" (
  id TEXT NOT NULL PRIMARY KEY, "tenantId" TEXT NOT NULL, operation TEXT NOT NULL,
  key TEXT NOT NULL, "inputHash" TEXT NOT NULL, "bookingId" TEXT NOT NULL,
  response JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingOperation_tenantId_bookingId_fkey" FOREIGN KEY ("tenantId", "bookingId") REFERENCES "Booking"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BookingOperation_tenantId_operation_key_key" ON "BookingOperation"("tenantId", operation, key);
CREATE INDEX "BookingOperation_tenantId_bookingId_idx" ON "BookingOperation"("tenantId", "bookingId");

CREATE FUNCTION protect_booking_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."quoteSnapshot" IS NOT NULL AND
    ROW(NEW."holdExpiresAt", NEW."holdExtensionCount") IS DISTINCT FROM ROW(OLD."holdExpiresAt", OLD."holdExtensionCount") AND
    (OLD.status <> 'HELD' OR NEW.status <> 'HELD' OR OLD."holdExtensionCount" <> 0 OR NEW."holdExtensionCount" <> 1
      OR OLD."holdExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
      OR NEW."holdExpiresAt" <> OLD."holdExpiresAt" + interval '15 minutes') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Booking_extension_invalid', MESSAGE = 'Booking_extension_invalid';
  END IF;
  IF OLD.status = 'HELD' AND NEW.status = 'EXPIRED' AND OLD."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Booking_expiry_invalid', MESSAGE = 'Booking_expiry_invalid';
  END IF;
  IF ROW(NEW.id, NEW.reference, NEW."tenantId", NEW."propertyId") IS DISTINCT FROM
     ROW(OLD.id, OLD.reference, OLD."tenantId", OLD."propertyId") OR
    (OLD."quoteSnapshot" IS NOT NULL AND ROW(NEW."quoteSnapshot", NEW."policySnapshot", NEW."quoteTotalKobo", NEW.currency,
      NEW."checkIn", NEW."checkOut", NEW."guestCount", NEW."guestName", NEW."guestPhone", NEW."holdStartedAt") IS DISTINCT FROM
     ROW(OLD."quoteSnapshot", OLD."policySnapshot", OLD."quoteTotalKobo", OLD.currency,
      OLD."checkIn", OLD."checkOut", OLD."guestCount", OLD."guestName", OLD."guestPhone", OLD."holdStartedAt")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Booking_terms_immutable', MESSAGE = 'Booking terms are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_terms_immutable BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION protect_booking_terms();

CREATE FUNCTION guard_booking_occupancy() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE active boolean; property_active boolean;
BEGIN
  active := NEW.status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING') OR
    (NEW.status = 'HELD' AND (NEW."holdExpiresAt" IS NULL OR NEW."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')));
  IF NOT active THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Occupancy_isolation', MESSAGE = 'Occupancy_isolation';
  END IF;
  IF NEW.status = 'HELD' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."tenantId" || ':' || booking_phone(NEW."guestPhone"), 42));
  END IF;
  SELECT "isActive" INTO property_active FROM "Property"
    WHERE id = NEW."propertyId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Composite FK supplies the ownership error.
  IF NOT property_active THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Occupancy_property_inactive', MESSAGE = 'Occupancy_property_inactive';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" b WHERE b."tenantId" = NEW."tenantId" AND b.id <> NEW.id
    AND b.status = 'HELD' AND b."holdExpiresAt" IS NULL AND b."propertyId" = NEW."propertyId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Occupancy_review_required', MESSAGE = 'Occupancy_review_required';
  END IF;
  IF NEW.status = 'HELD' AND EXISTS (SELECT 1 FROM "Booking" b WHERE b."tenantId" = NEW."tenantId" AND b.id <> NEW.id
    AND booking_phone(b."guestPhone") = booking_phone(NEW."guestPhone") AND b.status = 'HELD'
    AND (b."holdExpiresAt" IS NULL OR b."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Booking_guest_active_hold', MESSAGE = 'Booking_guest_active_hold';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" b WHERE b."tenantId" = NEW."tenantId" AND b."propertyId" = NEW."propertyId" AND b.id <> NEW.id
    AND (b.status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING') OR
      (b.status = 'HELD' AND (b."holdExpiresAt" IS NULL OR b."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))))
    AND tsrange(booking_day(b."checkIn"), booking_day(b."checkOut"), '[)') && tsrange(booking_day(NEW."checkIn"), booking_day(NEW."checkOut"), '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Booking_occupancy_conflict', MESSAGE = 'Booking_occupancy_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM "AvailabilityBlock" c WHERE c."tenantId" = NEW."tenantId" AND c."propertyId" = NEW."propertyId"
    AND tsrange(c."startDate", c."endDate", '[)') && tsrange(booking_day(NEW."checkIn"), booking_day(NEW."checkOut"), '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Booking_block_conflict', MESSAGE = 'Booking_block_conflict';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_occupancy_guard BEFORE INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION guard_booking_occupancy();

CREATE FUNCTION guard_block_occupancy() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM id FROM "Property" WHERE id = NEW."propertyId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Preserve the composite FK ownership error.
  IF TG_OP = 'UPDATE' AND ROW(NEW."tenantId", NEW."propertyId") IS DISTINCT FROM ROW(OLD."tenantId", OLD."propertyId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Block_identity_immutable', MESSAGE = 'Block ownership is immutable';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Occupancy_isolation', MESSAGE = 'Occupancy_isolation';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" b WHERE b."tenantId" = NEW."tenantId" AND b."propertyId" = NEW."propertyId"
    AND b.status = 'HELD' AND b."holdExpiresAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Occupancy_review_required', MESSAGE = 'Occupancy_review_required';
  END IF;
  IF EXISTS (SELECT 1 FROM "Booking" b WHERE b."tenantId" = NEW."tenantId" AND b."propertyId" = NEW."propertyId"
    AND (b.status IN ('CONFIRMED','PAYMENT_REVIEW','VERIFICATION_PENDING') OR
      (b.status = 'HELD' AND b."holdExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')))
    AND tsrange(booking_day(b."checkIn"), booking_day(b."checkOut"), '[)') && tsrange(NEW."startDate", NEW."endDate", '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Block_booking_conflict', MESSAGE = 'Block_booking_conflict';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER block_occupancy_guard BEFORE INSERT OR UPDATE ON "AvailabilityBlock" FOR EACH ROW EXECUTE FUNCTION guard_block_occupancy();
COMMIT;
