BEGIN;
-- CreateTable
CREATE TABLE "UsageGlobalPolicy" (
    "mode" TEXT NOT NULL,
    "monthlyCapMicroUsd" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageGlobalPolicy_pkey" PRIMARY KEY ("mode")
);

-- CreateTable
CREATE TABLE "UsagePolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "conversationAllowance" INTEGER NOT NULL,
    "monthlyCapMicroUsd" BIGINT NOT NULL,
    "minimumReservationMicroUsd" BIGINT NOT NULL,
    "maxRequestMicroUsd" BIGINT NOT NULL,
    "maxInputBytes" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER NOT NULL,
    "maxCallsPerTurn" INTEGER NOT NULL,
    "maxRetries" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsagePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT 'MODEL_CALL',
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT,
    "turnId" TEXT,
    "key" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "pricingVersion" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "inputRateMicroUsd" BIGINT NOT NULL,
    "outputRateMicroUsd" BIGINT NOT NULL,
    "estimatedInputTokens" INTEGER NOT NULL,
    "estimatedOutputTokens" INTEGER NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "accountedMicroUsd" BIGINT NOT NULL,
    "actualInputTokens" INTEGER,
    "actualOutputTokens" INTEGER,
    "actualMicroUsd" BIGINT,
    "settlementHash" TEXT,
    "errorCategory" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservationExpiresAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageWindow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "identityHash" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastInboundAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageInbound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "windowId" TEXT,
    "status" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageInbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsagePolicy_tenantId_mode_key" ON "UsagePolicy"("tenantId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_correlationId_key" ON "UsageEvent"("correlationId");

-- CreateIndex
CREATE INDEX "UsageEvent_mode_periodStart_idx" ON "UsageEvent"("mode", "periodStart");

-- CreateIndex
CREATE INDEX "UsageEvent_tenantId_mode_periodStart_idx" ON "UsageEvent"("tenantId", "mode", "periodStart");

-- CreateIndex
CREATE INDEX "UsageEvent_tenantId_conversationId_turnId_idx" ON "UsageEvent"("tenantId", "conversationId", "turnId");

-- CreateIndex
CREATE INDEX "UsageEvent_status_reservationExpiresAt_idx" ON "UsageEvent"("status", "reservationExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_tenantId_mode_key_key" ON "UsageEvent"("tenantId", "mode", "key");

-- CreateIndex
CREATE INDEX "UsageWindow_tenantId_mode_identityHash_expiresAt_idx" ON "UsageWindow"("tenantId", "mode", "identityHash", "expiresAt");

-- CreateIndex
CREATE INDEX "UsageWindow_tenantId_mode_periodStart_idx" ON "UsageWindow"("tenantId", "mode", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "UsageWindow_tenantId_mode_id_key" ON "UsageWindow"("tenantId", "mode", "id");

-- CreateIndex
CREATE UNIQUE INDEX "UsageInbound_tenantId_mode_eventHash_key" ON "UsageInbound"("tenantId", "mode", "eventHash");

-- CreateIndex
CREATE UNIQUE INDEX "UsageAlert_tenantId_mode_periodStart_code_threshold_key" ON "UsageAlert"("tenantId", "mode", "periodStart", "code", "threshold");

-- AddForeignKey
ALTER TABLE "UsagePolicy" ADD CONSTRAINT "UsagePolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_tenantId_conversationId_turnId_fkey" FOREIGN KEY ("tenantId", "conversationId", "turnId") REFERENCES "ConversationTurn"("tenantId", "conversationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageWindow" ADD CONSTRAINT "UsageWindow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageInbound" ADD CONSTRAINT "UsageInbound_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageInbound" ADD CONSTRAINT "UsageInbound_tenantId_mode_windowId_fkey" FOREIGN KEY ("tenantId", "mode", "windowId") REFERENCES "UsageWindow"("tenantId", "mode", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageAlert" ADD CONSTRAINT "UsageAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "UsageGlobalPolicy" ADD CONSTRAINT "UsageGlobalPolicy_values" CHECK (
 mode IN ('SIMULATION','PRODUCTION') AND "monthlyCapMicroUsd" BETWEEN 0 AND 999999999999999);
ALTER TABLE "UsagePolicy" ADD CONSTRAINT "UsagePolicy_values" CHECK (
 mode IN ('SIMULATION','PRODUCTION') AND plan IN ('STARTER','GROWTH','PRO')
 AND "conversationAllowance" BETWEEN 0 AND 1000000 AND "monthlyCapMicroUsd" BETWEEN 0 AND 999999999999999
 AND "minimumReservationMicroUsd" BETWEEN 0 AND "maxRequestMicroUsd" AND "maxRequestMicroUsd" BETWEEN 1 AND 999999999999999
 AND "maxInputBytes" BETWEEN 1 AND 32768 AND "maxOutputTokens" BETWEEN 1 AND 4000
 AND "maxCallsPerTurn" BETWEEN 1 AND 4 AND "maxRetries" BETWEEN 0 AND 3 AND "maxRetries" < "maxCallsPerTurn");
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_values" CHECK (
 mode IN ('SIMULATION','PRODUCTION') AND "eventType"='MODEL_CALL' AND currency='USD'
 AND "periodStart" < "periodEnd" AND "reservedAt" >= "periodStart" AND "reservedAt" < "periodEnd"
 AND "reservationExpiresAt" > "reservedAt" AND "inputHash" ~ '^[a-f0-9]{64}$' AND char_length(key) BETWEEN 8 AND 128
 AND ("turnId" IS NULL OR "conversationId" IS NOT NULL)
 AND "inputRateMicroUsd" >= 0 AND "outputRateMicroUsd" >= 0
 AND "estimatedInputTokens" BETWEEN 0 AND 32768 AND "estimatedOutputTokens" BETWEEN 1 AND 4000
 AND "reservedMicroUsd" >= "estimatedInputTokens"::bigint*"inputRateMicroUsd" + "estimatedOutputTokens"::bigint*"outputRateMicroUsd"
 AND "accountedMicroUsd" BETWEEN 0 AND "reservedMicroUsd"
 AND ("errorCategory" IS NULL OR "errorCategory" IN ('OUTCOME_UNKNOWN','KNOWN_ZERO_USAGE','NOT_DISPATCHED'))
 AND ((status IN ('RESERVED','REVIEW') AND "accountedMicroUsd"="reservedMicroUsd" AND "actualMicroUsd" IS NULL
       AND "actualInputTokens" IS NULL AND "actualOutputTokens" IS NULL AND "reconciledAt" IS NULL AND "releasedAt" IS NULL AND "completedAt" IS NULL)
 OR (status='COMPLETED' AND "dispatchedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "reconciledAt" IS NOT NULL
       AND "actualInputTokens" IS NOT NULL AND "actualOutputTokens" IS NOT NULL AND "actualMicroUsd" IS NOT NULL
       AND "actualInputTokens" BETWEEN 0 AND "estimatedInputTokens" AND "actualOutputTokens" BETWEEN 0 AND "estimatedOutputTokens"
       AND "actualMicroUsd"="actualInputTokens"::bigint*"inputRateMicroUsd"+"actualOutputTokens"::bigint*"outputRateMicroUsd" AND "accountedMicroUsd"="actualMicroUsd")
 OR (status IN ('FAILED','RELEASED') AND "accountedMicroUsd"=0 AND "releasedAt" IS NOT NULL AND "reconciledAt" IS NOT NULL
       AND "actualMicroUsd" IS NULL AND "actualInputTokens" IS NULL AND "actualOutputTokens" IS NULL AND "completedAt" IS NULL))
 AND (status <> 'RELEASED' OR "dispatchedAt" IS NULL)
 AND (status <> 'FAILED' OR ("dispatchedAt" IS NOT NULL AND "failedAt" IS NOT NULL))
 AND (status <> 'REVIEW' OR ("dispatchedAt" IS NOT NULL AND "failedAt" IS NOT NULL))
);
ALTER TABLE "UsageWindow" ADD CONSTRAINT "UsageWindow_no_overlap" EXCLUDE USING gist
 ("tenantId" WITH =, mode WITH =, "identityHash" WITH =, tsrange("startedAt","expiresAt",'[)') WITH &&);
ALTER TABLE "UsageWindow" ADD CONSTRAINT "UsageWindow_values" CHECK (
 mode IN ('SIMULATION','PRODUCTION') AND channel='WHATSAPP' AND "identityHash" ~ '^[a-f0-9]{64}$'
 AND "periodStart" < "periodEnd" AND "startedAt" >= "periodStart" AND "startedAt" < "periodEnd"
 AND "lastInboundAt" >= "startedAt" AND "expiresAt"="lastInboundAt"+interval '24 hours');
ALTER TABLE "UsageInbound" ADD CONSTRAINT "UsageInbound_values" CHECK (
 mode IN ('SIMULATION','PRODUCTION') AND "eventHash" ~ '^[a-f0-9]{64}$' AND "inputHash" ~ '^[a-f0-9]{64}$'
 AND ((status='ACCEPTED' AND "windowId" IS NOT NULL) OR (status='BLOCKED' AND "windowId" IS NULL)));
ALTER TABLE "UsageAlert" ADD CONSTRAINT "UsageAlert_values" CHECK (
 mode IN ('SIMULATION','PRODUCTION') AND threshold IN (0,70,85,100)
 AND code IN ('USAGE_CONFIGURATION_MISSING','PRODUCTION_AI_DISABLED','USAGE_INPUT_LIMIT','USAGE_TURN_LIMIT','USAGE_REQUEST_LIMIT',
 'TENANT_AI_CAP','GLOBAL_AI_CAP','TENANT_AI_WARNING','GLOBAL_AI_WARNING','CONVERSATION_ALLOWANCE','CONVERSATION_WARNING','USAGE_REVIEW_REQUIRED'));

CREATE FUNCTION protect_usage_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='UsageEvent_immutable',MESSAGE='UsageEvent_immutable';
 END IF;
 IF (to_jsonb(NEW) - ARRAY['status','accountedMicroUsd','actualInputTokens','actualOutputTokens','actualMicroUsd','settlementHash','errorCategory','dispatchedAt','completedAt','failedAt','releasedAt','reconciledAt'])
 IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','accountedMicroUsd','actualInputTokens','actualOutputTokens','actualMicroUsd','settlementHash','errorCategory','dispatchedAt','completedAt','failedAt','releasedAt','reconciledAt'])
 OR (OLD.status IN ('COMPLETED','FAILED','RELEASED') AND NEW IS DISTINCT FROM OLD)
 OR (OLD."dispatchedAt" IS NOT NULL AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt")
 OR (OLD.status='REVIEW' AND NEW.status='RESERVED') THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='UsageEvent_immutable',MESSAGE='UsageEvent_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER usage_event_guard BEFORE UPDATE OR DELETE ON "UsageEvent" FOR EACH ROW EXECUTE FUNCTION protect_usage_event();
DO $$ DECLARE protected_schema text := current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.protect_usage_event() SET search_path TO pg_catalog, %I, pg_temp',protected_schema,protected_schema);
END $$;
COMMIT;
