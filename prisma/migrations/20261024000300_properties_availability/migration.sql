-- PostgreSQL CHECK/exclusion constraints are intentionally maintained in SQL:
-- Prisma 6 cannot express them in schema.prisma. Keep them in future migrations.
BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "bathrooms" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancellationPolicy" TEXT,
ADD COLUMN     "cleaningFeeKobo" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "earlyCheckInAllowed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "earlyCheckInFrom" TEXT,
ADD COLUMN     "earlyCheckInRules" TEXT,
ADD COLUMN     "lateCheckOutAllowed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lateCheckOutRules" TEXT,
ADD COLUMN     "lateCheckOutUntil" TEXT,
ADD COLUMN     "refundPolicy" TEXT,
ADD COLUMN     "weekendNightlyPriceKobo" BIGINT;

-- CreateTable
CREATE TABLE "PropertyFee" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountKobo" BIGINT NOT NULL,

    CONSTRAINT "PropertyFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyFee_tenantId_propertyId_label_key" ON "PropertyFee"("tenantId", "propertyId", "label");

-- AddForeignKey
ALTER TABLE "PropertyFee" ADD CONSTRAINT "PropertyFee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyFee" ADD CONSTRAINT "PropertyFee_tenantId_propertyId_fkey" FOREIGN KEY ("tenantId", "propertyId") REFERENCES "Property"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve legacy fee intent while adding explicit early/late enable flags.
UPDATE "Property" SET "earlyCheckInAllowed" = ("earlyCheckInFeeKobo" IS NOT NULL),
  "lateCheckOutAllowed" = ("lateCheckOutFeeKobo" IS NOT NULL);
ALTER TABLE "Property" ALTER COLUMN "amenities" SET NOT NULL;

ALTER TABLE "Property" ADD CONSTRAINT "Property_capacity_check" CHECK (
  "bedrooms" BETWEEN 0 AND 100 AND "bathrooms" BETWEEN 0 AND 100 AND "maxGuests" BETWEEN 1 AND 1000
  AND "minimumStayNights" BETWEEN 1 AND 366 AND cardinality("amenities") <= 50
);
ALTER TABLE "Property" ADD CONSTRAINT "Property_money_check" CHECK (
  "baseNightlyPriceKobo" BETWEEN 1 AND 100000000000
  AND ("weekendNightlyPriceKobo" IS NULL OR "weekendNightlyPriceKobo" BETWEEN 1 AND 100000000000)
  AND "cleaningFeeKobo" BETWEEN 0 AND 100000000000
  AND ("earlyCheckInFeeKobo" IS NULL OR "earlyCheckInFeeKobo" BETWEEN 0 AND 100000000000)
  AND ("lateCheckOutFeeKobo" IS NULL OR "lateCheckOutFeeKobo" BETWEEN 0 AND 100000000000)
  AND "currency" = 'NGN'
);
ALTER TABLE "Property" ADD CONSTRAINT "Property_times_check" CHECK (
  "standardCheckIn" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "standardCheckOut" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND ("earlyCheckInFrom" IS NULL OR ("earlyCheckInFrom" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "earlyCheckInFrom" < "standardCheckIn"))
  AND ("lateCheckOutUntil" IS NULL OR ("lateCheckOutUntil" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "lateCheckOutUntil" > "standardCheckOut"))
);
ALTER TABLE "PropertyFee" ADD CONSTRAINT "PropertyFee_amount_check" CHECK (
  "amountKobo" BETWEEN 0 AND 100000000000 AND char_length(btrim(label)) BETWEEN 1 AND 80
);
CREATE UNIQUE INDEX "PropertyFee_label_case_key" ON "PropertyFee" ("tenantId", "propertyId", lower(label));

ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_dates_check" CHECK ("startDate" < "endDate");
-- The composite exclusion also supplies a GiST index and protects concurrent/raw writers.
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_no_overlap" EXCLUDE USING gist (
  "tenantId" public.gist_text_ops WITH =, "propertyId" public.gist_text_ops WITH =,
  tsrange("startDate", "endDate", '[)') WITH &&
);
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_values_check" CHECK (
  "nightlyPriceKobo" BETWEEN 1 AND 100000000000
  AND ("dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 0 AND 6)
  AND ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" < "endDate")
);
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_dates_no_overlap" EXCLUDE USING gist (
  "tenantId" public.gist_text_ops WITH =, "propertyId" public.gist_text_ops WITH =,
  tsrange("startDate", "endDate", '[)') WITH &&
) WHERE ("dayOfWeek" IS NULL AND "startDate" IS NOT NULL AND "endDate" IS NOT NULL);

COMMIT;

