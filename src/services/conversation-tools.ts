import { randomBytes } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { AuthContext } from './authentication.js';
import { TenantRepository } from './tenant-repository.js';
import { BookingService } from './booking-service.js';
import { PaymentService } from './payment-service.js';
import { quoteTermsHash, bookingQuote } from './booking-quote.js';
import { toolRequestSchema, tripSchema, type Inquiry } from './conversation-validation.js';
import { HttpError } from './errors.js';
import { id } from './validation.js';

export type EscalationReason = 'GUEST_REQUEST' | 'PAYMENT_REVIEW' | 'MISSING_CONFIGURATION' | 'MODEL_UNAVAILABLE' |
  'MODEL_INVALID_OUTPUT' | 'TOOL_FAILURE' | 'UNSUPPORTED_ACTION' | 'NO_AVAILABILITY' | 'SECURITY_REVIEW';
export type QuoteOffer = { id: string; hash: string; expiresAt: string; accepted: boolean;
  trip: { propertyId: string; checkIn: string; checkOut: string; guestCount: number }; snapshot: ReturnType<typeof bookingQuote>['snapshot'] };
export type ConversationWork = { id: string; inquiry: Inquiry; guestName: string | null; guestPhone: string | null;
  propertyOptions: { id: string; name: string; area: string }[]; quoteOffer: QuoteOffer | null; bookingId: string | null; paymentId: string | null };
export type ToolReply = { body: string; facts?: Prisma.InputJsonObject; escalation?: EscalationReason };
export function koboText(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(409, 'PRICING_INVALID');
  const kobo = BigInt(value);
  return `NGN ${(kobo / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(kobo % 100n).toString().padStart(2, '0')}`;
}
export function propertyText(value: string | null, max = 800) {
  if (value === null) return 'Not configured';
  if (/ignore.{0,30}(?:instructions|rules)|system prompt|(?:sk|pk)_(?:test|live)_|\bsk-[A-Za-z0-9_-]{8,}|api[ _-]?key|mark.{0,20}paid|(?:booking|payment).{0,25}(?:confirmed|approved|verified)|(?:pay|transfer).{0,30}\d{10}/i.test(value)) {
    throw new HttpError(409, 'PROPERTY_TEXT_REVIEW');
  }
  return value.replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}
function checkPropertyData(value: unknown): void {
  if (typeof value === 'string') { propertyText(value); return; }
  if (Array.isArray(value)) { value.forEach(checkPropertyData); return; }
  if (value && typeof value === 'object') Object.values(value).forEach(checkPropertyData);
}
export function missingDetails(work: ConversationWork, contact = false) {
  const missing = [];
  if (!work.inquiry.propertyId && !work.inquiry.area) missing.push('your preferred area or property');
  if (!work.inquiry.checkIn) missing.push('check-in date (YYYY-MM-DD)');
  if (!work.inquiry.checkOut) missing.push('check-out date (YYYY-MM-DD)');
  if (!work.inquiry.guestCount) missing.push('number of guests');
  if (contact && !work.guestName) missing.push('guest name');
  if (contact && !work.guestPhone) missing.push('guest phone number');
  return missing.length ? `Please provide ${missing.join(', ')}.` : 'Please choose a property, or ask for a quote, property details or a human.';
}

/** No SQL, arbitrary HTTP, tenant selector, verification or refund operation is exposed to the model. */
export class ConversationTools {
  private readonly repository: TenantRepository;
  private readonly bookings: BookingService;
  private readonly payments: PaymentService;
  constructor(db: PrismaClient, auth: AuthContext, private readonly work: ConversationWork,
    private readonly assertActive: () => Promise<void>, private readonly clock = () => new Date(),
    private readonly mutationGuard?: (tx: Prisma.TransactionClient) => Promise<void>,
    private readonly linkBooking?: (tx: Prisma.TransactionClient, bookingId: string) => Promise<void>,
    private readonly linkPayment?: (tx: Prisma.TransactionClient, paymentId: string) => Promise<void>) {
    this.repository = new TenantRepository(db, auth);
    this.bookings = new BookingService(db, auth, clock);
    // AI never initializes Paystack or gains verification capability.
    this.payments = new PaymentService(db, undefined, auth);
  }
  async run(input: unknown): Promise<ToolReply> {
    const request = toolRequestSchema.parse(input);
    await this.assertActive();
    switch (request.name) {
      case 'search_properties': {
        const properties = await this.repository.searchProperties(request.args);
        this.work.propertyOptions = properties.map((p) => ({ id: p.id, name: propertyText(p.name,120), area: propertyText(p.area,120) }));
        if (!properties.length) return { body: 'I could not find an active property matching those requirements. Staff assistance has been recorded; no notification has been sent.', escalation: 'NO_AVAILABILITY' };
        if (properties.length === 1) this.work.inquiry.propertyId = properties[0]!.id;
        return { body: this.work.propertyOptions.map((p,index) => `${index+1}. ${p.name} — ${p.area}`).join('\n') +
          (properties.length > 1 ? '\nWhich property would you like? Reply with its number.' : `\n${missingDetails(this.work)}`),
          facts: { properties: this.work.propertyOptions, reserved: false, availabilityNotChecked: true } };
      }
      case 'get_property_details': {
        const p = await this.repository.property(request.args.propertyId);
        if (!p.isActive) throw new HttpError(404,'NOT_FOUND');
        const facts = { id: p.id, name: propertyText(p.name,120), area: propertyText(p.area,120), address: propertyText(p.address),
          description: propertyText(p.description), bedrooms: p.bedrooms, bathrooms: p.bathrooms, maxGuests: p.maxGuests,
          amenities: p.amenities.map((value) => propertyText(value,80)), checkIn: p.standardCheckIn, checkOut: p.standardCheckOut,
          cancellationPolicy: propertyText(p.cancellationPolicy), refundPolicy: propertyText(p.refundPolicy) };
        return { body: `${facts.name}, ${facts.area}: ${facts.bedrooms} bedrooms, ${facts.bathrooms} bathrooms, up to ${facts.maxGuests} guests.\n` +
          `Amenities: ${facts.amenities.join(', ') || 'none recorded'}. Check-in ${facts.checkIn}; check-out ${facts.checkOut} (Africa/Lagos).\n` +
          `Description: ${facts.description}\nCancellation policy: ${facts.cancellationPolicy}\nRefund policy (configuration only): ${facts.refundPolicy}. No automated refunds are available.`,
          facts, ...(!p.cancellationPolicy || !p.refundPolicy ? { escalation: 'MISSING_CONFIGURATION' as const } : {}) };
      }
      case 'check_availability': {
        const p = await this.repository.property(request.args.propertyId);
        const available = await this.repository.availability(p.id, { checkIn: request.args.checkIn, checkOut: request.args.checkOut });
        const fits = p.maxGuests >= request.args.guestCount;
        return { body: available.available && fits ? 'Those nights are currently available for your group. This check does not reserve them; a hold rechecks availability.' :
          'Those dates or guest requirements are unavailable. Staff assistance has been recorded; no notification has been sent.',
          facts: { ...available, available: available.available && fits, reserved: false },
          ...(!available.available || !fits ? { escalation: 'NO_AVAILABILITY' as const } : {}) };
      }
      case 'get_quote': return this.quote(request.args);
      case 'create_booking_hold': {
        if (this.work.bookingId) return this.bookingStatus();
        const offer = this.work.quoteOffer;
        if (!offer || !offer.accepted) return { body: 'Please review a current backend quote and explicitly accept it before I create a hold.' };
        if (Date.parse(offer.expiresAt) <= this.clock().getTime()) return this.quote({ propertyId: this.work.inquiry.propertyId,
          checkIn: this.work.inquiry.checkIn, checkOut: this.work.inquiry.checkOut, guestCount: this.work.inquiry.guestCount });
        if (!this.work.guestName || !this.work.guestPhone) return { body: missingDetails(this.work, true) };
        const trip = tripSchema.parse({ propertyId: this.work.inquiry.propertyId, checkIn: this.work.inquiry.checkIn,
          checkOut: this.work.inquiry.checkOut, guestCount: this.work.inquiry.guestCount });
        if (trip.propertyId !== offer.trip.propertyId || trip.checkIn !== offer.trip.checkIn || trip.checkOut !== offer.trip.checkOut ||
          trip.guestCount !== offer.trip.guestCount) throw new HttpError(409,'QUOTE_CHANGED_REVIEW_REQUIRED');
        // Reuse core idempotency and commit the conversation link in the hold transaction.
        const result = await this.bookings.create('HELD', { ...trip, guestName: this.work.guestName, guestPhone: this.work.guestPhone },
          `conversation-hold:${this.work.id}`, offer.hash, this.mutationGuard, this.linkBooking) as { id: string };
        this.work.bookingId = id.parse(result.id);
        return this.bookingStatus();
      }
      case 'get_payment_instructions': {
        if (!this.work.bookingId) return { body: 'A current agreed booking hold is needed before payment instructions can be prepared.' };
        const booking = await this.bookings.get(this.work.bookingId);
        if (booking.status === 'CONFIRMED') return this.paymentStatus();
        if (!(await this.repository.property(booking.propertyId)).isActive) return {
          body: 'This property is inactive. Please wait for staff review before sending payment; no notification has been sent.', escalation: 'NO_AVAILABILITY' };
        if (booking.effectiveStatus !== 'HELD') return { body: 'This booking is not currently eligible for new payment instructions. Staff review is recorded; no notification has been sent.', escalation: 'PAYMENT_REVIEW' };
        const payment = this.work.paymentId ? await this.payments.get(this.work.paymentId) :
          await this.payments.create({ bookingId: this.work.bookingId, method: 'MANUAL_TRANSFER' }, `conversation-payment:${this.work.id}`, this.mutationGuard, this.linkPayment);
        this.work.paymentId = payment.id;
        const instructions = payment.transferInstructions as { bankName: string; accountName: string; accountNumber: string; reference: string; amountKobo: number } | null;
        if (!instructions) throw new HttpError(409,'PAYMENT_INSTRUCTIONS_MISSING');
        return { body: `Transfer ${koboText(instructions.amountKobo)} to ${propertyText(instructions.bankName,120)}, account name ${propertyText(instructions.accountName,120)}, account ${instructions.accountNumber}. Reference: ${payment.reference}.\n` +
          'Payment remains pending until an authorized operator checks the bank ledger. A screenshot or guest claim is not proof. The hold is not a confirmed booking.',
          facts: { paymentId: payment.id, reference: payment.reference, status: payment.status, transferInstructions: instructions, confirmed: false } };
      }
      case 'check_payment_status': return this.paymentStatus();
      case 'request_human_assistance': return { body: 'Your request is recorded for staff review with this conversation. No automatic notification has been sent.', escalation: 'GUEST_REQUEST' };
    }
  }
  private async quote(input: unknown): Promise<ToolReply> {
    if (this.work.bookingId) return this.bookingStatus();
    const trip = tripSchema.parse(input);
    const snapshot = await this.bookings.quote(trip);
    checkPropertyData(snapshot);
    if (!snapshot.property.cancellationPolicy?.trim() || !snapshot.property.refundPolicy?.trim()) throw new HttpError(409,'POLICY_CONFIGURATION_MISSING');
    const name = propertyText(snapshot.property.name,120);
    const cancellation = propertyText(snapshot.property.cancellationPolicy), refund = propertyText(snapshot.property.refundPolicy);
    const fees = snapshot.fees.map((fee) => `${propertyText(fee.label,80)}: ${koboText(fee.amountKobo)}`).join('; ');
    const offer: QuoteOffer = { id: randomBytes(16).toString('hex'), hash: quoteTermsHash(snapshot),
      expiresAt: new Date(this.clock().getTime()+5*60000).toISOString(), accepted: false, trip, snapshot };
    this.work.quoteOffer = offer;
    return { body: `${name}: ${trip.checkIn} to ${trip.checkOut}, ${snapshot.nights} night(s), ${trip.guestCount} guest(s), Africa/Lagos.\n` +
      `Nightly charges: ${koboText(snapshot.nightlyTotalKobo)}. Fees: ${fees}. Total: ${koboText(snapshot.totalKobo)}.\n` +
      `Cancellation: ${cancellation}\nRefund policy (configuration only): ${refund}.\n` +
      'This quote does not reserve dates. Would you like me to create a hold on these terms? Reply “I agree” or send acceptQuoteId. I will recheck the terms and availability.',
      facts: { quoteId: offer.id, expiresAt: offer.expiresAt, snapshot, reserved: false } };
  }
  private async bookingStatus(): Promise<ToolReply> {
    if (!this.work.bookingId) return { body: 'There is no booking hold associated with this conversation.' };
    const booking = await this.bookings.get(this.work.bookingId);
    const facts = { bookingId: booking.id, reference: booking.reference, status: booking.status, effectiveStatus: booking.effectiveStatus,
      confirmed: booking.confirmed, holdExpiresAt: booking.holdExpiresAt };
    if (booking.status === 'CONFIRMED' && booking.confirmed) return { body: `Your booking ${booking.reference} is confirmed according to the backend.`, facts };
    if (booking.effectiveStatus === 'HELD') return { body: `Booking ${booking.reference} is on hold until ${booking.holdExpiresAt}. Payment has not been verified by this conversation. A hold is not a confirmed booking. You can ask for payment instructions.`, facts };
    return { body: `Booking ${booking.reference} is ${booking.effectiveStatus}. It is not confirmed. Staff review is recorded; no notification has been sent.`, facts, escalation: 'PAYMENT_REVIEW' };
  }
  private async paymentStatus(): Promise<ToolReply> {
    if (!this.work.bookingId) return { body: 'No booking is associated with this conversation. A payment claim or screenshot cannot verify funds. Staff review is recorded; no notification has been sent.', escalation: 'PAYMENT_REVIEW' };
    const booking = await this.bookings.get(this.work.bookingId);
    const payments = (await this.payments.list({ bookingId: booking.id, limit: 100 })).payments;
    const facts = { bookingId: booking.id, status: booking.status, effectiveStatus: booking.effectiveStatus, confirmed: booking.confirmed,
      payments: payments.map((p) => ({ id: p.id, status: p.status, reviewReason: p.reviewReason, bookingConfirmed: p.bookingConfirmed })) };
    if (booking.status === 'CONFIRMED' && booking.confirmed) return { body: `Your booking ${booking.reference} is confirmed according to the backend.`, facts,
      ...(payments.some((p) => p.reviewReason) ? { escalation: 'PAYMENT_REVIEW' as const } : {}) };
    if (!payments.length && booking.effectiveStatus === 'HELD') return this.bookingStatus();
    const review = payments.some((p) => p.reviewReason || ['REVIEW','VERIFYING','SUCCEEDED','INITIALIZING'].includes(p.status)) || booking.effectiveStatus !== 'HELD';
    return { body: review ? 'Payment needs staff verification or review. Your booking is not confirmed. Staff review is recorded; no notification has been sent.' :
      'Payment is pending. Your booking is not confirmed. Guest claims and screenshots do not verify receipt; an authorized operator must check the bank ledger.',
      facts, ...(review ? { escalation: 'PAYMENT_REVIEW' as const } : {}) };
  }
}
