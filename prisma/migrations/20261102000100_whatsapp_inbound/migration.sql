BEGIN;
-- DropIndex
DROP INDEX "ChannelConnection_channel_externalBusinessId_key";

-- CreateTable
CREATE TABLE "WhatsAppInbound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "metaMessageId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "eventAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usageStatus" TEXT NOT NULL,

    CONSTRAINT "WhatsAppInbound_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppInbound_tenantId_receivedAt_idx" ON "WhatsAppInbound"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppInbound_tenantId_phoneNumberId_metaMessageId_key" ON "WhatsAppInbound"("tenantId", "phoneNumberId", "metaMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppInbound_tenantId_conversationId_messageId_key" ON "WhatsAppInbound"("tenantId", "conversationId", "messageId");

-- CreateIndex
CREATE INDEX "ChannelConnection_channel_externalBusinessId_idx" ON "ChannelConnection"("channel", "externalBusinessId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_channel_externalPhoneNumberId_key" ON "ChannelConnection"("channel", "externalPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_tenantId_id_externalPhoneNumberId_key" ON "ChannelConnection"("tenantId", "id", "externalPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_conversationId_id_key" ON "Message"("tenantId", "conversationId", "id");

-- AddForeignKey
ALTER TABLE "WhatsAppInbound" ADD CONSTRAINT "WhatsAppInbound_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppInbound" ADD CONSTRAINT "WhatsAppInbound_tenantId_connectionId_phoneNumberId_fkey" FOREIGN KEY ("tenantId", "connectionId", "phoneNumberId") REFERENCES "ChannelConnection"("tenantId", "id", "externalPhoneNumberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsAppInbound" ADD CONSTRAINT "WhatsAppInbound_tenantId_conversationId_messageId_fkey" FOREIGN KEY ("tenantId", "conversationId", "messageId") REFERENCES "Message"("tenantId", "conversationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve business-ID uniqueness for channels that do not identify individual numbers.
CREATE UNIQUE INDEX "ChannelConnection_other_business_key" ON "ChannelConnection" (channel,"externalBusinessId") WHERE channel <> 'WHATSAPP';
-- Refuse ambiguous legacy mappings atomically; never auto-assign ownership.
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_whatsapp_values" CHECK (
 channel <> 'WHATSAPP' OR (("externalPhoneNumberId" IS NULL AND NOT "isActive") OR
 ("externalPhoneNumberId" IS NOT NULL AND "externalPhoneNumberId" ~ '^[1-9][0-9]{0,31}$' AND "externalBusinessId" ~ '^[1-9][0-9]{0,31}$')));
ALTER TABLE "WhatsAppInbound" ADD CONSTRAINT "WhatsAppInbound_values" CHECK (
 "inputHash" ~ '^[a-f0-9]{64}$' AND char_length("metaMessageId") BETWEEN 1 AND 256
 AND "messageType"='text' AND "usageStatus" IN ('ACCEPTED','BLOCKED')
 AND "eventAt" >= timestamp '2000-01-01' AND "eventAt" <= "receivedAt" + interval '5 minutes');
CREATE FUNCTION protect_whatsapp_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.channel='WHATSAPP' AND ROW(NEW.id,NEW."tenantId",NEW.channel,NEW."externalBusinessId",NEW."externalPhoneNumberId")
 IS DISTINCT FROM ROW(OLD.id,OLD."tenantId",OLD.channel,OLD."externalBusinessId",OLD."externalPhoneNumberId") THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='WhatsApp_connection_identity_immutable',MESSAGE='WhatsApp_connection_identity_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_connection_guard BEFORE UPDATE ON "ChannelConnection" FOR EACH ROW EXECUTE FUNCTION protect_whatsapp_connection();
DO $$ DECLARE protected_schema text := current_schema(); BEGIN
 EXECUTE format('ALTER FUNCTION %I.protect_whatsapp_connection() SET search_path TO pg_catalog, %I, pg_temp',protected_schema,protected_schema);
END $$;

COMMIT;
