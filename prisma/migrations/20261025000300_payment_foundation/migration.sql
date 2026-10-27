BEGIN;
-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('MANUAL_TRANSFER', 'PAYSTACK_TEST');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIALIZING', 'PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'REVIEW');

-- CreateTable
CREATE TABLE "BankTransferSetting" (
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransferSetting_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "expectedAmountKobo" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "idempotencyKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "customerEmail" TEXT,
    "instructionsSnapshot" JSONB,
    "authorizationUrl" TEXT,
    "providerReference" TEXT,
    "providerTransactionId" TEXT,
    "providerDetails" JSONB,
    "manualReceiptReference" TEXT,
    "receivedAmountKobo" BIGINT,
    "receivedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifierId" TEXT,
    "reviewReason" TEXT,
    "reviewNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reference_key" ON "Payment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerReference_key" ON "Payment"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerTransactionId_key" ON "Payment"("providerTransactionId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_bookingId_status_idx" ON "Payment"("tenantId", "bookingId", "status");

-- CreateIndex
CREATE INDEX "Payment_tenantId_status_createdAt_idx" ON "Payment"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_id_key" ON "Payment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_manualReceiptReference_key" ON "Payment"("tenantId", "manualReceiptReference");

-- AddForeignKey
ALTER TABLE "BankTransferSetting" ADD CONSTRAINT "BankTransferSetting_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_bookingId_fkey" FOREIGN KEY ("tenantId", "bookingId") REFERENCES "Booking"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_verifierId_fkey" FOREIGN KEY ("tenantId", "verifierId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "BankTransferSetting" ADD CONSTRAINT "BankTransferSetting_values_check" CHECK (
  char_length(btrim("bankName")) BETWEEN 1 AND 120 AND char_length(btrim("accountName")) BETWEEN 1 AND 120
  AND "accountNumber" ~ '^[0-9]{10}$'
);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_values_check" CHECK (
  "expectedAmountKobo" BETWEEN 1 AND 9007199254740991 AND currency = 'NGN'
  AND ("receivedAmountKobo" IS NULL OR "receivedAmountKobo" BETWEEN 1 AND 9007199254740991)
  AND reference ~ '^SLP-[a-f0-9]{32}$'
  AND ((method = 'MANUAL_TRANSFER' AND "providerReference" IS NULL AND "instructionsSnapshot" IS NOT NULL)
    OR (method = 'PAYSTACK_TEST' AND "providerReference" IS NOT NULL AND "providerReference" = reference AND "customerEmail" IS NOT NULL))
  AND (status <> 'SUCCEEDED' OR ("verifiedAt" IS NOT NULL AND "receivedAt" IS NOT NULL
    AND "receivedAmountKobo" IS NOT NULL AND "receivedAmountKobo" = "expectedAmountKobo"
    AND ((method = 'MANUAL_TRANSFER' AND "verifierId" IS NOT NULL AND "manualReceiptReference" IS NOT NULL)
      OR (method = 'PAYSTACK_TEST' AND "providerTransactionId" IS NOT NULL))))
  AND ("appliedAt" IS NULL OR status = 'SUCCEEDED')
);
CREATE UNIQUE INDEX "Payment_applied_booking_key" ON "Payment" ("tenantId", "bookingId") WHERE "appliedAt" IS NOT NULL;

CREATE FUNCTION protect_payment_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW."tenantId",NEW."bookingId",NEW.reference,NEW.method,NEW."expectedAmountKobo",NEW.currency,
    NEW."idempotencyKey",NEW."inputHash",NEW."customerEmail",NEW."instructionsSnapshot",NEW."providerReference") IS DISTINCT FROM
    ROW(OLD.id,OLD."tenantId",OLD."bookingId",OLD.reference,OLD.method,OLD."expectedAmountKobo",OLD.currency,
    OLD."idempotencyKey",OLD."inputHash",OLD."customerEmail",OLD."instructionsSnapshot",OLD."providerReference")
    OR (OLD.status = 'SUCCEEDED' AND ROW(NEW.status,NEW."receivedAmountKobo",NEW."receivedAt",NEW."verifiedAt",NEW."verifierId",
      NEW."providerTransactionId",NEW."manualReceiptReference") IS DISTINCT FROM
      ROW(OLD.status,OLD."receivedAmountKobo",OLD."receivedAt",OLD."verifiedAt",OLD."verifierId",
      OLD."providerTransactionId",OLD."manualReceiptReference"))
    OR (OLD."appliedAt" IS NOT NULL AND NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt") THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='Payment_terms_immutable', MESSAGE='Payment_terms_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_terms_immutable BEFORE UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION protect_payment_terms();

CREATE FUNCTION guard_payment_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Original legacy CONFIRMED rows remain readable; no historical payment is invented.
  IF NEW.status = 'CONFIRMED' AND NEW."quoteSnapshot" IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='Payment_confirmation_required', MESSAGE='Payment_confirmation_required';
    END IF;
    IF OLD.status <> 'CONFIRMED' AND (
      OLD.status NOT IN ('HELD','PAYMENT_REVIEW','VERIFICATION_PENDING')
      OR OLD."holdExpiresAt" IS NULL OR OLD."holdExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
      OR NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."tenantId" = NEW."tenantId" AND p."bookingId" = NEW.id
        AND p.reference = NEW."paymentReference" AND p.status = 'SUCCEEDED' AND p."verifiedAt" IS NOT NULL
        AND p."receivedAmountKobo" = NEW."quoteTotalKobo" AND p.currency = NEW.currency)
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='Payment_confirmation_required', MESSAGE='Payment_confirmation_required';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_confirmation_guard BEFORE INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION guard_payment_confirmation();

DO $$
DECLARE routine text; protected_schema text := current_schema();
BEGIN
  FOREACH routine IN ARRAY ARRAY['protect_payment_terms','guard_payment_confirmation'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog, %I, pg_temp',
      protected_schema,routine,protected_schema);
  END LOOP;
END $$;
COMMIT;

