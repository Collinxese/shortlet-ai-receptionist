BEGIN;
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "bookingId" TEXT,
ADD COLUMN     "creationHash" TEXT,
ADD COLUMN     "inquiry" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "propertyOptions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "quoteOffer" JSONB,
ADD COLUMN     "simulation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "turnId" TEXT;

-- CreateTable
CREATE TABLE "ConversationTurn" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "leaseToken" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEscalation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ConversationEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationTurn_tenantId_conversationId_status_idx" ON "ConversationTurn"("tenantId", "conversationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_tenantId_conversationId_id_key" ON "ConversationTurn"("tenantId", "conversationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_tenantId_conversationId_key_key" ON "ConversationTurn"("tenantId", "conversationId", "key");

-- CreateIndex
CREATE INDEX "ConversationEscalation_tenantId_status_createdAt_idx" ON "ConversationEscalation"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationEscalation_tenantId_conversationId_createdAt_idx" ON "ConversationEscalation"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_simulation_updatedAt_idx" ON "Conversation"("tenantId", "simulation", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenantId_bookingId_key" ON "Conversation"("tenantId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_turnId_direction_key" ON "Message"("tenantId", "turnId", "direction");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_bookingId_fkey" FOREIGN KEY ("tenantId", "bookingId") REFERENCES "Booking"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_conversationId_turnId_fkey" FOREIGN KEY ("tenantId", "conversationId", "turnId") REFERENCES "ConversationTurn"("tenantId", "conversationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEscalation" ADD CONSTRAINT "ConversationEscalation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEscalation" ADD CONSTRAINT "ConversationEscalation_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEscalation" ADD CONSTRAINT "ConversationEscalation_tenantId_resolvedById_fkey" FOREIGN KEY ("tenantId", "resolvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_simulation_values_check" CHECK (
 NOT simulation OR (channel = 'WEBSITE' AND "externalId" LIKE 'simulation:%' AND "creationHash" IS NOT NULL AND "creationHash" ~ '^[a-f0-9]{64}$'
 AND "handlingMode" IN ('AI','HUMAN') AND jsonb_typeof(inquiry) = 'object' AND jsonb_typeof("propertyOptions") = 'array')
);
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_values_check" CHECK (
 "inputHash" ~ '^[a-f0-9]{64}$' AND "leaseToken" ~ '^[a-f0-9]{32}$' AND char_length(key) BETWEEN 8 AND 128
 AND jsonb_typeof(request) = 'object' AND ((status = 'PROCESSING' AND response IS NULL AND "completedAt" IS NULL)
 OR (status = 'COMPLETED' AND response IS NOT NULL AND "completedAt" IS NOT NULL))
);
ALTER TABLE "ConversationEscalation" ADD CONSTRAINT "ConversationEscalation_values_check" CHECK (
 reason IN ('GUEST_REQUEST','PAYMENT_REVIEW','MISSING_CONFIGURATION','MODEL_UNAVAILABLE','MODEL_INVALID_OUTPUT','TOOL_FAILURE','UNSUPPORTED_ACTION','NO_AVAILABILITY','SECURITY_REVIEW')
 AND jsonb_typeof(context) = 'object' AND ((status = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL)
 OR (status = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL))
);
CREATE UNIQUE INDEX "ConversationEscalation_one_open_reason" ON "ConversationEscalation"("tenantId","conversationId",reason) WHERE status = 'OPEN';
CREATE UNIQUE INDEX "ConversationTurn_one_processing" ON "ConversationTurn"("tenantId","conversationId") WHERE status = 'PROCESSING';
ALTER TABLE "Message" ADD CONSTRAINT "Message_turn_direction_check" CHECK ("turnId" IS NULL OR direction IN ('IN','OUT'));
CREATE FUNCTION guard_conversation_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (ROW(NEW.id,NEW."tenantId",NEW.simulation) IS DISTINCT FROM ROW(OLD.id,OLD."tenantId",OLD.simulation)
 OR (OLD."bookingId" IS NOT NULL AND NEW."bookingId" IS DISTINCT FROM OLD."bookingId")
 OR (OLD."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId")) THEN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='Conversation_links_immutable', MESSAGE='Conversation_links_immutable';
 END IF;
 IF NEW."paymentId" IS NOT NULL AND (NEW."bookingId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "Payment" p WHERE p.id = NEW."paymentId" AND p."tenantId" = NEW."tenantId" AND p."bookingId" = NEW."bookingId"
 )) THEN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='Conversation_payment_booking_match', MESSAGE='Conversation_payment_booking_match';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER conversation_links_guard BEFORE INSERT OR UPDATE ON "Conversation" FOR EACH ROW EXECUTE FUNCTION guard_conversation_links();
DO $$ DECLARE protected_schema text := current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.guard_conversation_links() SET search_path TO pg_catalog, %I, pg_temp',protected_schema,protected_schema);
END $$;

COMMIT;
