BEGIN;
-- AlterTable
ALTER TABLE "ChannelConnection" ADD COLUMN     "credentialDigest" TEXT,
ADD COLUMN     "verificationAttempt" TEXT,
ADD COLUMN     "verificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "whatsappEnvironment" TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
ADD COLUMN     "whatsappState" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION';

-- AlterTable
ALTER TABLE "UsageWindow" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'INTERNAL_SIMULATION';

-- AlterTable
ALTER TABLE "UsageInbound" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'INTERNAL_SIMULATION';

-- AlterTable
ALTER TABLE "WhatsAppInbound" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'META_LEGACY_UNCLASSIFIED';


-- Existing activation was operator-declared, not verified ownership. Preserve its history, fail closed.
INSERT INTO "AuditLog" (id,"tenantId","actorType",action,"entityType","entityId",before,after)
 SELECT 'whatsapp-ownership-upgrade:' || id,"tenantId",'SYSTEM','whatsapp.verification_reset','ChannelConnection',id,
 jsonb_build_object('isActive',"isActive",'lastVerifiedAt',"lastVerifiedAt"),
 jsonb_build_object('state','PENDING_VERIFICATION','reason','OWNERSHIP_PROOF_REQUIRED')
 FROM "ChannelConnection" WHERE channel='WHATSAPP';
UPDATE "ChannelConnection" SET "isActive"=false,"lastVerifiedAt"=NULL WHERE channel='WHATSAPP';
UPDATE "UsageInbound" SET source='META_PRODUCTION' WHERE mode='PRODUCTION';
UPDATE "UsageWindow" SET source='META_PRODUCTION' WHERE mode='PRODUCTION';
-- Phase 6B stored no trusted test/production provenance. Identify its receipt keys exactly,
-- without guessing the environment or altering money, timestamps or deduplication keys.
WITH keys AS (
 SELECT "tenantId",encode(sha256(convert_to('"' || encode(sha256(convert_to(
  '["META_WHATSAPP",' || to_json("phoneNumberId")::text || ',' || to_json("metaMessageId")::text || ']',
  'UTF8')),'hex') || '"','UTF8')),'hex') AS hash FROM "WhatsAppInbound"
)
UPDATE "UsageInbound" r SET source='META_LEGACY_UNCLASSIFIED' FROM keys k
 WHERE r."tenantId"=k."tenantId" AND r."eventHash"=k.hash AND r.mode='SIMULATION';
UPDATE "UsageWindow" w SET source=CASE WHEN EXISTS (SELECT 1 FROM "UsageInbound" r
 WHERE r."windowId"=w.id AND r.source='INTERNAL_SIMULATION') THEN 'LEGACY_MIXED' ELSE 'META_LEGACY_UNCLASSIFIED' END
 WHERE EXISTS (SELECT 1 FROM "UsageInbound" r WHERE r."windowId"=w.id AND r.source='META_LEGACY_UNCLASSIFIED');
-- Namespacing prevents a Meta test ticket from sharing an internal simulation window.
-- A legacy mixed window retains its internal counting continuity, visibly labelled mixed.
UPDATE "UsageWindow" SET "identityHash"=encode(sha256(convert_to('["' || "identityHash" || '","' ||
 CASE WHEN source='LEGACY_MIXED' THEN 'INTERNAL_SIMULATION' ELSE source END || '"]','UTF8')),'hex');
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_ownership_values" CHECK (
 channel <> 'WHATSAPP' OR ("whatsappEnvironment" IN ('UNCLASSIFIED','META_TEST','META_PRODUCTION') AND
 (("whatsappState"='PENDING_VERIFICATION' AND NOT "isActive" AND "lastVerifiedAt" IS NULL AND "verificationExpiresAt" IS NULL AND "credentialDigest" IS NULL)
 OR ("whatsappState" IN ('VERIFIED','ACTIVE') AND "isActive"=("whatsappState"='ACTIVE') AND "verificationAttempt" IS NULL
 AND "whatsappEnvironment" IN ('META_TEST','META_PRODUCTION') AND "lastVerifiedAt" IS NOT NULL
 AND "verificationExpiresAt" IS NOT NULL AND "verificationExpiresAt">"lastVerifiedAt" AND "credentialDigest" IS NOT NULL
 AND "credentialDigest" ~ '^[a-f0-9]{64}$'))));
ALTER TABLE "UsageInbound" ADD CONSTRAINT "UsageInbound_source_values" CHECK (
 (mode='SIMULATION' AND source IN ('INTERNAL_SIMULATION','META_TEST','META_LEGACY_UNCLASSIFIED')) OR
 (mode='PRODUCTION' AND source='META_PRODUCTION'));
ALTER TABLE "UsageWindow" ADD CONSTRAINT "UsageWindow_source_values" CHECK (
 (mode='SIMULATION' AND source IN ('INTERNAL_SIMULATION','META_TEST','META_LEGACY_UNCLASSIFIED','LEGACY_MIXED')) OR
 (mode='PRODUCTION' AND source='META_PRODUCTION'));
ALTER TABLE "WhatsAppInbound" ADD CONSTRAINT "WhatsAppInbound_source_values" CHECK (
 source IN ('META_TEST','META_PRODUCTION','META_LEGACY_UNCLASSIFIED'));

COMMIT;
