import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { guestPhone } from './booking-validation.js';
import { id } from './validation.js';
import { redactText } from './conversation-validation.js';
import { HttpError } from './errors.js';

export const metaId = z.string().regex(/^[1-9][0-9]{0,31}$/);
export const connectionBody = z.strictObject({ phoneNumberId: metaId, businessId: metaId,
  displayName: z.string().trim().min(1).max(120).optional(), isActive: z.boolean().default(false) });
export const connectionPatch = z.strictObject({ isActive: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(120).optional() }).refine(v => Object.keys(v).length > 0);
export const connectionParams = z.strictObject({ connectionId: id });
export const verificationQuery = z.strictObject({ 'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string().min(1).max(512), 'hub.challenge': z.string().regex(/^[0-9]{1,128}$/) });
export const bodyDigest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export const identityDigest = (value: unknown) => bodyDigest(JSON.stringify(value));
export function matchesToken(actual: string, expected: string) {
  return timingSafeEqual(createHash('sha256').update(actual).digest(),createHash('sha256').update(expected).digest());
}
export function verifyMetaSignature(body: Buffer, signature: string | string[] | undefined, secret: string) {
  if (!Buffer.isBuffer(body) || typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
    !timingSafeEqual(createHmac('sha256',secret).update(body).digest(),Buffer.from(signature.slice(7),'hex'))) {
    throw new HttpError(401,'INVALID_WEBHOOK_SIGNATURE');
  }
}
const messageId = z.string().regex(/^[A-Za-z0-9._:+/=-]{1,256}$/);
const timestamp = z.string().regex(/^[0-9]{1,12}$/);
const envelope = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  id: metaId, changes: z.array(z.object({ field: z.string().min(1).max(80), value: z.record(z.string(),z.unknown()) })).min(1).max(20)
})).min(1).max(20) });
const messagesValue = z.object({ messaging_product: z.literal('whatsapp'), metadata: z.object({ phone_number_id: metaId }),
  messages: z.array(z.object({ id: messageId, from: z.string().regex(/^[1-9][0-9]{7,14}$/), timestamp,
    type: z.string().min(1).max(40), text: z.object({ body: z.string().min(1).max(2000) }).optional(),
    is_echo: z.boolean().optional() })).min(1).max(100).optional(),
  statuses: z.array(z.object({ id: messageId, timestamp, status: z.enum(['sent','delivered','read','failed','deleted']),
    recipient_id: z.string().regex(/^[1-9][0-9]{7,14}$/) })).min(1).max(100).optional()
}).refine(v => Boolean(v.messages || v.statuses));
export type InboundItem = { kind: 'TEXT'; businessId: string; phoneNumberId: string; metaMessageId: string;
  phone: string; text: string; eventAt: Date; inputHash: string } |
  { kind: 'STATUS' | 'ECHO' | 'UNSUPPORTED'; phoneNumberId?: string; businessId: string };
export function normalizeMetaPayload(value: unknown, now: Date): InboundItem[] {
  const result: InboundItem[] = [];
  const eventTime = (raw: string) => {
    const millis = Number(raw)*1000;
    if (millis < Date.UTC(2000,0,1) || millis > now.getTime()+300000) throw new HttpError(400,'INVALID_WEBHOOK_PAYLOAD');
    return new Date(millis);
  };
  for (const entry of envelope.parse(value).entry) for (const change of entry.changes) {
    if (change.field !== 'messages') {
      result.push({ kind: change.field === 'smb_message_echoes' ? 'ECHO' : 'UNSUPPORTED', businessId: entry.id });
      continue;
    }
    const data = messagesValue.parse(change.value), phoneNumberId = data.metadata.phone_number_id;
    for (const status of data.statuses ?? []) { eventTime(status.timestamp); result.push({kind:'STATUS',businessId:entry.id,phoneNumberId}); }
    for (const message of data.messages ?? []) {
      const eventAt = eventTime(message.timestamp);
      if (message.is_echo || message.type !== 'text') {
        result.push({kind:message.is_echo ? 'ECHO':'UNSUPPORTED',businessId:entry.id,phoneNumberId}); continue;
      }
      if (!message.text?.body.trim()) throw new HttpError(400,'INVALID_WEBHOOK_PAYLOAD');
      const phone = guestPhone.parse(`+${message.from}`);
      result.push({kind:'TEXT',businessId:entry.id,phoneNumberId,metaMessageId:message.id,phone,eventAt,
        text:redactText(message.text.body,{guestPhone:phone}),
        inputHash:identityDigest([entry.id,phoneNumberId,message.id,phone,eventAt.toISOString(),message.text.body])});
    }
  }
  if (result.length > 100) throw new HttpError(400,'INVALID_WEBHOOK_PAYLOAD');
  return result;
}
