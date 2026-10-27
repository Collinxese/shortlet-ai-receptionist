import { z } from 'zod';
import { id, name } from './validation.js';
import { calendarDate, calendarRange } from './calendar.js';
import { guestPhone, bookingQuoteBody } from './booking-validation.js';

export const inquirySchema = z.strictObject({ area: name.optional(), propertyId: id.optional(), checkIn: calendarDate.optional(),
  checkOut: calendarDate.optional(), guestCount: z.number().int().min(1).max(1000).optional(),
  bedrooms: z.number().int().min(0).max(100).optional(), amenities: z.array(name).max(10).optional() });
export type Inquiry = z.infer<typeof inquirySchema>;
export const guestDetails = inquirySchema.extend({ guestName: name.optional(), guestPhone: guestPhone.optional() });
export const createConversationBody = z.strictObject({ details: guestDetails.default({}) });
export const guestMessageBody = z.strictObject({ text: z.string().trim().min(1).max(2000), details: guestDetails.default({}),
  acceptQuoteId: z.string().regex(/^[a-f0-9]{32}$/).optional() });
export const conversationParams = z.strictObject({ conversationId: id });
export const conversationListQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0) });
export const historyQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), before: id.optional() });
export const handlingBody = z.strictObject({ mode: z.enum(['AI', 'HUMAN']) });

export const actions = ['greet', 'collect_details', 'search_properties', 'get_property_details', 'check_availability', 'get_quote',
  'create_booking_hold', 'get_payment_instructions', 'check_payment_status', 'request_human_assistance'] as const;
export const modelPlanSchema = z.strictObject({ action: z.enum(actions), area: name.nullable(), propertyId: id.nullable(),
  checkIn: calendarDate.nullable(), checkOut: calendarDate.nullable(), guestCount: z.number().int().min(1).max(1000).nullable(),
  bedrooms: z.number().int().min(0).max(100).nullable(), amenities: z.array(name).max(10).nullable() });
export type ModelPlan = z.infer<typeof modelPlanSchema>;
export function plan(action: ModelPlan['action'], details: Partial<Omit<ModelPlan, 'action'>> = {}): ModelPlan {
  return { action, area: null, propertyId: null, checkIn: null, checkOut: null, guestCount: null, bedrooms: null, amenities: null, ...details };
}
export const tripSchema = bookingQuoteBody;
export const toolRequestSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('search_properties'), args: inquirySchema.pick({ area: true, guestCount: true, bedrooms: true, amenities: true }) }),
  z.strictObject({ name: z.literal('get_property_details'), args: z.strictObject({ propertyId: id }) }),
  z.strictObject({ name: z.literal('check_availability'), args: tripSchema }),
  z.strictObject({ name: z.literal('get_quote'), args: tripSchema }),
  ...(['create_booking_hold', 'get_payment_instructions', 'check_payment_status', 'request_human_assistance'] as const)
    .map((value) => z.strictObject({ name: z.literal(value), args: z.strictObject({}) }))
]);

export function validInquiry(input: unknown): Inquiry {
  const value = inquirySchema.parse(input);
  if (value.checkIn && value.checkOut) calendarRange.parse({ startDate: value.checkIn, endDate: value.checkOut });
  return value;
}
export function isAgreement(text: string) {
  return /^(?:yes|yes please|i agree|i agree to (?:the|that) quote|i accept (?:the|that) quote|please create (?:the|a) hold)[.!]?$/i.test(text.trim());
}

// Recognizable booking literals must survive number redaction, including two
// adjacent ISO dates. Credential/name detection still runs before this split.
function bookingTextParts(text: string) {
  return text.split(/(\b\d{4}-\d{2}-\d{2}\b|\bSLP-[a-f0-9]{32}\b|\bLEGACY-[A-Za-z0-9_-]+\b|\bc[a-z0-9]{20,31}\b)/g);
}
const phonePattern = /(?<![\p{L}\p{N}_])(?:\+|00)?(?:\(\d{1,4}\)|\d)[\d ().-]*\d(?![\p{L}\p{N}_])/gu;
function phoneCandidates(text: string) {
  return bookingTextParts(text).filter((_part,index) => index % 2 === 0).flatMap((part) => [...part.matchAll(phonePattern)].map((match) => match[0]));
}
function suppliedPhone(text: string) {
  for (const candidate of phoneCandidates(text)) {
    let normalized = candidate.replace(/[ ().-]/g,'');
    if (normalized.startsWith('00')) normalized = `+${normalized.slice(2)}`;
    if (/^234[789]\d{9}$/.test(normalized)) normalized = `+${normalized}`;
    // Never invent a country for a bare international/local number. Nigerian
    // local numbers retain the booking service's existing normalization.
    if (!/^\+[1-9]\d{7,14}$/.test(normalized) && !/^0[789]\d{9}$/.test(normalized)) continue;
    const parsed = guestPhone.safeParse(normalized);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
function suppliedNames(text: string) {
  const patterns = [
    /\b(?:my\s+(?:full\s+)?name\s+is|(?:full\s+)?name\s*[:=]|(?:you\s+can\s+)?call\s+me)\s*([\p{L}][\p{L}\p{M}'’-]*(?:[ \t]+[\p{L}][\p{L}\p{M}'’-]*){0,5})/giu,
    /\b(?:[Ii]\s+am|[Ii]['’]m|[Tt]his\s+is)\s+([\p{Lu}][\p{L}\p{M}'’-]*(?:[ \t]+[\p{Lu}][\p{L}\p{M}'’-]*){0,5})/gu
  ];
  const stop = /^(?:and|on|at|via|back|phone|mobile|telephone|tel|email|contact|number|please|for|from|with|here|looking|interested|booking|ready|coming|travell?ing|planning|checking|paying|not|available|happy|sorry|excited|okay|sure|requesting|asking|searching|hello|hi)$/i;
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].flatMap((match) => {
    const words = match[1]!.split(/[ \t]+/), end = words.findIndex((word) => stop.test(word));
    const value = words.slice(0,end < 0 ? undefined : end).join(' ');
    return value && value.length <= 120 ? [value] : [];
  }));
}
function removeContact(text: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'giu'),'[contact removed]');
}
/** Heuristic minimization, not a guarantee of complete PII/credential removal. */
export function redactText(text: string, contact?: { guestName?: string | null; guestPhone?: string | null }) {
  let result = text.replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]{8,}|\b(?:gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[credential removed]')
    .replace(/\b(?:api[ _-]?key|(?:access|refresh|session|auth)[ _-]?token|authorization|secret(?:[ _-]?key)?)\s*(?:is|[:=])\s*(?:\[credential removed\]|\S+)/gi,'[credential removed]')
    .replace(/\b(?:password|cvv|otp|pin|card\s*number)\s*(?:is|[:=])?\s*\S{3,128}/gi, '[sensitive value removed]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]');
  for (const value of [contact?.guestName, ...suppliedNames(text)]) if (value) result = removeContact(result,value);
  result = bookingTextParts(result).map((part,index) => index % 2 ? part : part.replace(phonePattern,(candidate) => {
    const digits = candidate.replace(/\D/g,'');
    if ((candidate.startsWith('+') || candidate.startsWith('00')) && digits.length >= 8 && digits.length <= 17) return '[phone removed]';
    if (digits.length >= 10 && digits.length <= 15) return '[phone removed]';
    return digits.length >= 13 && digits.length <= 19 ? '[number removed]' : candidate;
  })).join('');
  if (contact?.guestPhone) result = removeContact(result,contact.guestPhone);
  return result.slice(0, 2000);
}
/** These checks improve fallback behavior. Tool authorization/consent never relies on them. */
export function sensitiveRequest(text: string) {
  return /ignore.{0,30}(?:rules|instructions)|system prompt|credentials?|api[ _-]?keys?|another.{0,30}(?:guest|customer|reservation|booking)|tenant[ _-]?id|mark.{0,20}paid|confirm my booking|owner.{0,30}approved|verify.{0,20}payment|(?:issue|process|send|give|approve|want|need).{0,15}refund|^refund[.!]?$|cancel.{0,30}confirmed/i.test(text);
}
export function extractGuestDetails(text: string) {
  const result: z.infer<typeof guestDetails> = {};
  const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (dates?.[0]) result.checkIn = dates[0];
  if (dates?.[1]) result.checkOut = dates[1];
  const count = text.match(/\b(\d+)\s*(?:guests?|people|persons?|adults?)\b/i);
  if (count) result.guestCount = Number(count[1]);
  const beds = text.match(/\b(\d+)\s*bedrooms?\b/i);
  if (beds) result.bedrooms = Number(beds[1]);
  const phone = suppliedPhone(text);
  if (phone) result.guestPhone = phone;
  const guest = suppliedNames(text)[0];
  if (guest) result.guestName = guest;
  const area = text.match(/(?:\bin\s+|area:\s*|location:\s*)([\p{L} .'-]{1,80})/iu);
  if (area) result.area = area[1]!.split(/\b(?:from|for|on|with|check.?in)\b/i)[0]!.trim();
  return guestDetails.parse(result);
}
