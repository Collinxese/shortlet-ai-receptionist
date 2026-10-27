import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient, type Conversation } from '@prisma/client';
import type { AuthContext } from './authentication.js';
import { hasPermission, type Permission } from './authorization.js';
import { HttpError } from './errors.js';
import { idempotencyKey } from './booking-validation.js';
import { lagosDate } from './calendar.js';
import { ConversationTools, missingDetails, type ConversationWork, type ToolReply, type EscalationReason, type QuoteOffer } from './conversation-tools.js';
import type { ConversationModel, ModelContext } from './conversation-model.js';
import { createConversationBody, guestMessageBody, extractGuestDetails, validInquiry, modelPlanSchema,
  isAgreement, redactText, sensitiveRequest, tripSchema, conversationListQuery, historyQuery, handlingBody, type ModelPlan } from './conversation-validation.js';

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 10000 };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
function tripValues(inquiry: ConversationWork['inquiry']) {
  return { propertyId: inquiry.propertyId, checkIn: inquiry.checkIn, checkOut: inquiry.checkOut, guestCount: inquiry.guestCount };
}

/** All inputs are simulated guest text submitted through authenticated staff context. */
export class ConversationService {
  private readonly tenantId: string;
  constructor(private readonly db: PrismaClient, private readonly auth: AuthContext, private readonly model: ConversationModel,
    private readonly modelTimeoutMs = 5000, private readonly clock = () => new Date()) {
    this.tenantId = auth.user.tenantId;
    if (!this.tenantId) throw new HttpError(401,'UNAUTHORIZED');
  }
  private permit(permission: Permission) {
    if (!hasPermission(this.auth.user.role, permission)) throw new HttpError(403,'FORBIDDEN');
  }
  private async record(tx: Prisma.TransactionClient, id: string, lock = false) {
    if (lock) await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} AND "tenantId" = ${this.tenantId} AND simulation = true FOR UPDATE`;
    const row = await tx.conversation.findFirst({ where: { id, tenantId: this.tenantId, simulation: true } });
    if (!row) throw new HttpError(404,'NOT_FOUND');
    return row;
  }
  private audit(tx: Prisma.TransactionClient, conversationId: string, action: string, after: Prisma.InputJsonObject) {
    return tx.auditLog.create({ data: { tenantId: this.tenantId, actorId: this.auth.user.id, actorType: 'USER',
      action, entityType: 'Conversation', entityId: conversationId, after } });
  }
  private work(row: Conversation): ConversationWork {
    return { id: row.id, inquiry: validInquiry(row.inquiry), guestName: row.guestName, guestPhone: row.guestPhone,
      propertyOptions: row.propertyOptions as ConversationWork['propertyOptions'], quoteOffer: row.quoteOffer as QuoteOffer | null,
      bookingId: row.bookingId, paymentId: row.paymentId };
  }
  private providerName() { return ['mock','openai','disabled'].includes(this.model.name) ? this.model.name : 'custom'; }
  private response(row: Conversation) {
    return { id: row.id, simulated: true, modelProvider: this.providerName(), handlingMode: row.handlingMode,
      needsAttention: row.needsAttention, inquiry: row.inquiry, bookingId: row.bookingId, paymentId: row.paymentId,
      hasGuestName: Boolean(row.guestName), hasGuestPhone: Boolean(row.guestPhone), lastMessageAt: row.lastMessageAt, createdAt: row.createdAt };
  }
  async create(input: unknown, keyInput: unknown) {
    this.permit('inbox:reply');
    const { details } = createConversationBody.parse(input), key = idempotencyKey.parse(keyInput);
    const { guestName, guestPhone, ...inquiry } = details;
    validInquiry(inquiry);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.tenantId,'conversation.create',key])}, 51))::text`;
      const externalId = `simulation:${key}`;
      const existing = await tx.conversation.findUnique({ where: { tenantId_channel_externalId: { tenantId: this.tenantId, channel: 'WEBSITE', externalId } } });
      if (existing) {
        if (!existing.simulation || existing.creationHash !== hash(details)) throw new HttpError(409,'IDEMPOTENCY_CONFLICT');
        return this.response(existing);
      }
      const row = await tx.conversation.create({ data: { tenantId: this.tenantId, channel: 'WEBSITE', externalId,
        simulation: true, creationHash: hash(details), inquiry, guestName, guestPhone } });
      await this.audit(tx,row.id,'conversation.created',{ simulated: true });
      return this.response(row);
    },txOptions);
  }
  async get(id: string) {
    this.permit('inbox:read');
    return this.response(await this.record(this.db,id));
  }
  async list(input: unknown) {
    this.permit('inbox:read');
    const { limit, offset } = conversationListQuery.parse(input);
    const rows = await this.db.conversation.findMany({ where: { tenantId: this.tenantId, simulation: true }, take: limit, skip: offset,
      orderBy: [{ updatedAt: 'desc' },{ id: 'desc' }] });
    return { conversations: rows.map((row) => this.response(row)), limit, offset };
  }
  async history(id: string, input: unknown) {
    this.permit('inbox:read');
    const { limit, before } = historyQuery.parse(input);
    await this.record(this.db,id);
    const cursor = before ? await this.db.message.findFirst({ where: { id: before, tenantId: this.tenantId, conversationId: id } }) : null;
    if (before && !cursor) throw new HttpError(404,'NOT_FOUND');
    const rows = await this.db.message.findMany({ where: { tenantId: this.tenantId, conversationId: id,
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      select: { id: true, direction: true, body: true, turnId: true, createdAt: true }, orderBy: [{ createdAt: 'desc' },{ id: 'desc' }], take: limit });
    const active = await this.db.conversationTurn.findFirst({ where: { tenantId: this.tenantId, conversationId: id, status: 'PROCESSING' },
      select: { key: true, leaseUntil: true } });
    return { messages: rows.reverse(), nextBefore: rows.length === limit ? rows[0]!.id : null, activeTurn: active };
  }
  async escalations(id: string) {
    this.permit('inbox:read');
    await this.record(this.db,id);
    return this.db.conversationEscalation.findMany({ where: { tenantId: this.tenantId, conversationId: id },
      select: { id: true, reason: true, context: true, status: true, createdAt: true, resolvedAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  async handling(id: string, input: unknown) {
    this.permit('inbox:takeover');
    const { mode } = handlingBody.parse(input);
    return this.db.$transaction(async (tx) => {
      await this.record(tx,id,true);
      if (mode === 'AI') {
        const pending = await tx.conversationTurn.count({ where: { tenantId: this.tenantId, conversationId: id, status: 'PROCESSING' } });
        if (pending) throw new HttpError(409,'TURN_IN_PROGRESS');
        await tx.conversationEscalation.updateMany({ where: { tenantId: this.tenantId, conversationId: id, status: 'OPEN' },
          data: { status: 'RESOLVED', resolvedAt: this.clock(), resolvedById: this.auth.user.id } });
      }
      const row = await tx.conversation.update({ where: { id, tenantId: this.tenantId }, data: { handlingMode: mode, needsAttention: mode === 'HUMAN' } });
      await this.audit(tx,id,'conversation.handling_changed',{ mode });
      return this.response(row);
    },txOptions);
  }
  private async assertActive(id: string, turnId: string, token: string) {
    const [conversation, turn] = await Promise.all([this.record(this.db,id), this.db.conversationTurn.findFirst({
      where: { id: turnId, tenantId: this.tenantId, conversationId: id, status: 'PROCESSING', leaseToken: token, leaseUntil: { gt: this.clock() } } })]);
    if (!turn) throw new HttpError(409,'TURN_LEASE_LOST');
    if (conversation.handlingMode !== 'AI') throw new HttpError(409,'CONVERSATION_TAKEN_OVER');
  }
  async send(id: string, input: unknown, keyInput: unknown) {
    this.permit('inbox:reply');
    const data = guestMessageBody.parse(input), key = idempotencyKey.parse(keyInput);
    const prepared = await this.db.$transaction(async (tx) => {
      const conversation = await this.record(tx,id,true), now = this.clock();
      const existing = await tx.conversationTurn.findUnique({ where: { tenantId_conversationId_key: { tenantId: this.tenantId, conversationId: id, key } } });
      if (existing) {
        if (existing.inputHash !== hash(data)) throw new HttpError(409,'IDEMPOTENCY_CONFLICT');
        if (existing.status === 'COMPLETED') return { replay: existing.response };
        if (existing.leaseUntil > now) throw new HttpError(409,'TURN_IN_PROGRESS');
        const token = randomBytes(16).toString('hex');
        const turn = await tx.conversationTurn.update({ where: { id: existing.id, tenantId: this.tenantId },
          data: { leaseToken: token, leaseUntil: new Date(now.getTime()+120000) } });
        return { conversation, turn };
      }
      const pending = await tx.conversationTurn.findFirst({ where: { tenantId: this.tenantId, conversationId: id, status: 'PROCESSING' } });
      if (pending) throw new HttpError(409,pending.leaseUntil > now ? 'TURN_IN_PROGRESS' : 'TURN_RECOVERY_REQUIRED');
      const { guestName, guestPhone, ...fields } = { ...extractGuestDetails(data.text), ...data.details };
      const inquiry = validInquiry({ ...validInquiry(conversation.inquiry), ...fields });
      const changed = hash(tripValues(inquiry)) !== hash(tripValues(validInquiry(conversation.inquiry)));
      const quote = changed ? null : conversation.quoteOffer as QuoteOffer | null;
      if (data.acceptQuoteId && (!quote || quote.id !== data.acceptQuoteId)) throw new HttpError(409,'QUOTE_ACCEPTANCE_INVALID');
      if (quote && (data.acceptQuoteId === quote.id || isAgreement(data.text))) quote.accepted = true;
      const selection = /^(?:property\s+|option\s+|choose\s+)?([1-9]|10)[.!]?$/i.exec(data.text.trim());
      if (selection) {
        const option = (conversation.propertyOptions as ConversationWork['propertyOptions'])[Number(selection[1])-1];
        if (!option) throw new HttpError(400,'INVALID_PROPERTY_SELECTION');
        if (inquiry.propertyId !== option.id) { inquiry.propertyId = option.id; }
      }
      const selectedChanged = hash(tripValues(inquiry)) !== hash(tripValues(validInquiry(conversation.inquiry)));
      const updated = await tx.conversation.update({ where: { id, tenantId: this.tenantId }, data: { inquiry,
        guestName: guestName ?? conversation.guestName, guestPhone: guestPhone ?? conversation.guestPhone,
        quoteOffer: selectedChanged ? Prisma.DbNull : quote ? json(quote) : Prisma.DbNull, lastMessageAt: now } });
      const message = redactText(data.text,{ guestName: updated.guestName, guestPhone: updated.guestPhone });
      const turn = await tx.conversationTurn.create({ data: { tenantId: this.tenantId, conversationId: id, key, inputHash: hash(data),
        leaseToken: randomBytes(16).toString('hex'), leaseUntil: new Date(now.getTime()+120000), request: { message } } });
      await tx.message.create({ data: { tenantId: this.tenantId, conversationId: id, turnId: turn.id, direction: 'IN', body: message } });
      return { conversation: updated, turn };
    },txOptions);
    if ('replay' in prepared) return prepared.replay;
    const { turn, conversation } = prepared;
    const work = this.work(conversation), message = (turn.request as { message: string }).message;
    const active = () => this.assertActive(id,turn.id,turn.leaseToken);
    let reply: ToolReply;
    let action = 'collect_details';
    if (conversation.handlingMode !== 'AI') reply = { body: 'Your message has been saved for staff review. No automatic notification has been sent.' };
    else if (sensitiveRequest(message)) reply = { body: 'I cannot reveal internal information or change booking/payment approval. Staff review has been recorded; no notification has been sent.', escalation: 'SECURITY_REVIEW' };
    else {
      let stage = 'model';
      try {
        const context: ModelContext = { message, inquiry: work.inquiry, hasHold: Boolean(work.bookingId), hasQuote: Boolean(work.quoteOffer),
          hasConsent: Boolean(work.quoteOffer?.accepted), hasName: Boolean(work.guestName), hasPhone: Boolean(work.guestPhone), today: lagosDate(this.clock()) };
        const output = await this.modelPlan(context);
        const parsed = modelPlanSchema.safeParse(output);
        if (!parsed.success) throw new HttpError(409,'MODEL_INVALID_OUTPUT');
        const modelPlan = parsed.data;
        this.applySlots(work,modelPlan,message);
        action = modelPlan.action;
        stage = 'tool';
        const guard = async (tx: Prisma.TransactionClient) => {
          const current = await this.record(tx,id,true);
          const token = await tx.conversationTurn.findFirst({ where: { id: turn.id, tenantId: this.tenantId, conversationId: id,
            status: 'PROCESSING', leaseToken: turn.leaseToken, leaseUntil: { gt: this.clock() } } });
          if (!token) throw new HttpError(409,'TURN_LEASE_LOST');
          if (current.handlingMode !== 'AI') throw new HttpError(409,'CONVERSATION_TAKEN_OVER');
        };
        const linkBooking = async (tx: Prisma.TransactionClient, bookingId: string) => {
          await tx.conversation.update({ where: { id, tenantId: this.tenantId }, data: { bookingId } });
          await this.audit(tx,id,'conversation.booking_linked',{ bookingId, turnId: turn.id });
        };
        const linkPayment = async (tx: Prisma.TransactionClient, paymentId: string) => {
          await tx.conversation.update({ where: { id, tenantId: this.tenantId }, data: { paymentId } });
          await this.audit(tx,id,'conversation.payment_linked',{ paymentId, turnId: turn.id });
        };
        const tools = new ConversationTools(this.db,this.auth,work,active,this.clock,guard,linkBooking,linkPayment);
        if (action === 'greet' || action === 'collect_details') reply = { body: `${action === 'greet' ? 'Hello! I can help you find a short-let and prepare a booking hold. ' : ''}${missingDetails(work,Boolean(work.quoteOffer?.accepted))}` };
        else {
          const args = action === 'search_properties' ? { area: work.inquiry.area, guestCount: work.inquiry.guestCount, bedrooms: work.inquiry.bedrooms, amenities: work.inquiry.amenities } :
            action === 'get_property_details' ? { propertyId: work.inquiry.propertyId } :
            action === 'check_availability' || action === 'get_quote' ? tripValues(work.inquiry) : {};
          if (action === 'get_property_details' && !work.inquiry.propertyId) reply = { body: missingDetails(work) };
          else if ((action === 'get_quote' || action === 'check_availability') && !tripSchema.safeParse(args).success) reply = { body: missingDetails(work) };
          else {
            reply = await tools.run({ name: action, args });
            if (action === 'check_payment_status' && /\bpaid\b|screenshot|receipt/i.test(message) && reply.facts?.confirmed !== true) {
              reply = { ...reply, body: reply.body + ' Your payment claim has been recorded for staff review; no automatic notification has been sent.', escalation: 'PAYMENT_REVIEW' };
            }
          }
        }
      } catch (error) {
        if (error instanceof HttpError && error.code === 'TURN_LEASE_LOST') throw error;
        if (error instanceof HttpError && error.code === 'QUOTE_CHANGED_REVIEW_REQUIRED') {
          work.quoteOffer = null;
          reply = { body: 'The property terms have changed since that quote. Please request a fresh quote and accept it before a hold is created.' };
        } else {
          const code = error instanceof HttpError ? error.code : stage === 'model' ? 'MODEL_UNAVAILABLE' : 'TOOL_FAILURE';
          const reason: EscalationReason = code === 'MODEL_INVALID_OUTPUT' ? 'MODEL_INVALID_OUTPUT' : code === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' :
            /PRICING|CONFIGURATION|BANK_TRANSFER_DISABLED|INSTRUCTIONS_MISSING|PROPERTY_TEXT/.test(code) ? 'MISSING_CONFIGURATION' :
            /UNAVAILABLE|CAPACITY|STAY|INACTIVE/.test(code) ? 'NO_AVAILABILITY' : 'TOOL_FAILURE';
          reply = { body: 'I could not safely complete that request. Your inquiry is saved for staff review; no automatic notification has been sent.', escalation: reason };
        }
      }
    }
    return this.db.$transaction(async (tx) => {
      const current = await this.record(tx,id,true);
      const fenced = await tx.conversationTurn.findFirst({ where: { id: turn.id, tenantId: this.tenantId, conversationId: id,
        status: 'PROCESSING', leaseToken: turn.leaseToken, leaseUntil: { gt: this.clock() } } });
      if (!fenced) throw new HttpError(409,'TURN_LEASE_LOST');
      if (current.handlingMode !== 'AI' && conversation.handlingMode === 'AI') {
        reply = { body: 'Staff have taken over this conversation. Your message is saved; no automatic notification has been sent.' };
      }
      if (reply.escalation) {
        const exists = await tx.conversationEscalation.findFirst({ where: { tenantId: this.tenantId, conversationId: id, reason: reply.escalation, status: 'OPEN' } });
        if (!exists) {
          await tx.conversationEscalation.create({ data: { tenantId: this.tenantId, conversationId: id, reason: reply.escalation,
            context: json({ inquiry: work.inquiry, turnId: turn.id, bookingId: work.bookingId, paymentId: work.paymentId }) } });
          await this.audit(tx,id,'conversation.escalated',{ reason: reply.escalation, turnId: turn.id, notificationSent: false });
        }
      }
      const updated = await tx.conversation.update({ where: { id, tenantId: this.tenantId }, data: { inquiry: work.inquiry,
        propertyOptions: work.propertyOptions, quoteOffer: work.quoteOffer ? json(work.quoteOffer) : Prisma.DbNull,
        bookingId: work.bookingId, paymentId: work.paymentId, ...(reply.escalation ? { needsAttention: true, handlingMode: 'HUMAN' } : {}), lastMessageAt: this.clock() } });
      const out = await tx.message.create({ data: { tenantId: this.tenantId, conversationId: id, turnId: turn.id, direction: 'OUT', body: reply.body } });
      const result = json({ conversation: this.response(updated), turnId: turn.id, message: { id: out.id, direction: 'OUT', body: out.body, createdAt: out.createdAt },
        action, facts: reply.facts ?? null, escalationRecorded: Boolean(reply.escalation), notificationSent: false });
      await tx.conversationTurn.update({ where: { id: turn.id, tenantId: this.tenantId }, data: { status: 'COMPLETED', response: result, completedAt: this.clock() } });
      await this.audit(tx,id,'conversation.turn_completed',{ turnId: turn.id, action, modelProvider: this.providerName() });
      return result;
    },txOptions);
  }
  private applySlots(work: ConversationWork, output: ModelPlan, message: string) {
    const previous = hash(tripValues(work.inquiry));
    for (const field of ['area','propertyId','checkIn','checkOut','guestCount','bedrooms','amenities'] as const) {
      const value = output[field];
      if (value === null) continue;
      const existing = work.inquiry[field];
      const values = Array.isArray(value) ? value : [String(value)];
      const supported = field === 'guestCount' ? new RegExp(`\\b${value}\\s*(?:guests?|people|persons?|adults?)\\b`,'i').test(message) :
        field === 'bedrooms' ? new RegExp(`\\b${value}\\s*bedrooms?\\b`,'i').test(message) : values.every((part) => message.toLowerCase().includes(part.toLowerCase()));
      if (JSON.stringify(existing) !== JSON.stringify(value) && !supported) {
        throw new HttpError(409,'MODEL_INVALID_OUTPUT');
      }
      work.inquiry = validInquiry({ ...work.inquiry, [field]: value });
    }
    if (hash(tripValues(work.inquiry)) !== previous) work.quoteOffer = null;
  }
  private async modelPlan(context: ModelContext) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.model.plan(context,controller.signal),new Promise<never>((_resolve,reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new HttpError(503,'MODEL_UNAVAILABLE')); },this.modelTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
}
