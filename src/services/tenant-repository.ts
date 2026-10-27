import { Prisma, type PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { publicUserSelect, type AuthContext } from './authentication.js';
import { HttpError } from './errors.js';
import { hashPassword } from './passwords.js';
import type { createTeamBody, updateTeamBody } from './validation.js';
import { hasPermission, type Permission } from './authorization.js';
import { asDateRange, BOOKING_TIMEZONE, lagosMidnight, nightsBetween } from './calendar.js';
import { isDateRangeAvailable } from './availability.js';
import { integrityAlert, occupyingBookings, tenantProperty } from './occupancy.js';
import { nightlyPrices } from './pricing.js';
import {
  availabilityQuery, calendarListQuery, createBlockBody, createPriceOverrideBody,
  createPropertyBody, propertyListQuery, propertyTimes, updatePropertyBody, validListRange
} from './property-validation.js';
import { propertySearchQuery } from './property-validation.js';
import {
  blockResponse, configurationChanges, priceOverrideResponse, propertyConfiguration, propertyInclude, propertyResponse
} from './property-data.js';

/**
 * Business routes use this narrow repository, never a raw Prisma delegate.
 * Its tenant ID comes only from a validated session. Every read/write repeats
 * the tenant filter, including updates after a record has already been checked.
 * Add future business operations here with the same rule; do not expose generic
 * Prisma arguments or nested writes supplied by a client.
 */
export class TenantRepository {
  private readonly tenantId: string;

  constructor(private readonly db: PrismaClient, private readonly auth: AuthContext) {
    this.tenantId = auth.user.tenantId;
    if (!this.tenantId) throw new HttpError(401, 'UNAUTHORIZED');
  }

  tenant() {
    return this.db.tenant.findUniqueOrThrow({
      where: { id: this.tenantId }, select: { id: true, name: true, timezone: true }
    });
  }

  async renameTenant(name: string) {
    return this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.update({
        where: { id: this.tenantId }, data: { name }, select: { id: true, name: true, timezone: true }
      });
      await this.audit(tx, 'tenant.updated', 'Tenant', this.tenantId, { name });
      return tenant;
    });
  }

  team() {
    return this.db.user.findMany({
      where: { tenantId: this.tenantId }, select: publicUserSelect,
      orderBy: { id: 'asc' }, take: 100
    });
  }

  async teamMember(id: string) {
    const user = await this.db.user.findFirst({
      where: { id, tenantId: this.tenantId }, select: publicUserSelect
    });
    if (!user) throw new HttpError(404, 'NOT_FOUND');
    return user;
  }

  async createTeamMember(input: z.infer<typeof createTeamBody>) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { tenantId: this.tenantId, name: input.name, email: input.email, role: input.role, passwordHash },
          select: publicUserSelect
        });
        await this.audit(tx, 'team.created', 'User', user.id, { role: user.role });
        return user;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new HttpError(409, 'ACCOUNT_UNAVAILABLE');
      }
      throw error;
    }
  }

  async updateTeamMember(id: string, data: z.infer<typeof updateTeamBody>) {
    return this.db.$transaction(async (tx) => {
      const target = await tx.user.findFirst({ where: { id, tenantId: this.tenantId }, select: publicUserSelect });
      if (!target) throw new HttpError(404, 'NOT_FOUND');
      // Phase 1 has one owner per tenant; ownership transfer is deliberately unavailable.
      if (target.role === 'OWNER' || id === this.auth.user.id) throw new HttpError(403, 'FORBIDDEN');
      const user = await tx.user.update({
        where: { id, tenantId: this.tenantId, role: { not: 'OWNER' } }, data, select: publicUserSelect
      });
      if (data.isActive === false) {
        await tx.authSession.deleteMany({ where: { tenantId: this.tenantId, userId: id } });
      }
      await this.audit(tx, 'team.updated', 'User', user.id, data);
      return user;
    });
  }

  auditLogs(limit: number) {
    return this.db.auditLog.findMany({
      where: { tenantId: this.tenantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
      select: { id: true, tenantId: true, actorId: true, action: true, entityType: true, entityId: true, createdAt: true, before: true, after: true }
    });
  }

  private permit(permission: Permission) {
    if (!hasPermission(this.auth.user.role, permission)) throw new HttpError(403, 'FORBIDDEN');
  }

  private async propertyRecord(tx: Prisma.TransactionClient, propertyId: string, lock = false) {
    return tenantProperty(tx, this.tenantId, propertyId, lock);
  }

  async listProperties(query: unknown) {
    this.permit('properties:read');
    const { status, limit, offset } = propertyListQuery.parse(query);
    const properties = await this.db.property.findMany({
      where: { tenantId: this.tenantId, ...(status === 'all' ? {} : { isActive: status === 'active' }) },
      include: propertyInclude, orderBy: { id: 'asc' }, take: limit, skip: offset
    });
    return { properties: properties.map(propertyResponse), limit, offset };
  }

  async searchProperties(input: unknown) {
    this.permit('properties:read');
    const data = propertySearchQuery.parse(input);
    const properties = await this.db.property.findMany({ where: { tenantId: this.tenantId, isActive: true,
      ...(data.area ? { area: { contains: data.area, mode: 'insensitive' } } : {}),
      ...(data.guestCount ? { maxGuests: { gte: data.guestCount } } : {}),
      ...(data.bedrooms !== undefined ? { bedrooms: { gte: data.bedrooms } } : {}),
      ...(data.amenities?.length ? { amenities: { hasEvery: data.amenities } } : {}) },
      include: propertyInclude, orderBy: { id: 'asc' }, take: 10 });
    return properties.map(propertyResponse);
  }

  async property(propertyId: string) {
    this.permit('properties:read');
    return propertyResponse(await this.propertyRecord(this.db, propertyId));
  }

  async createProperty(input: unknown) {
    this.permit('properties:write');
    const { otherFees, ...data } = createPropertyBody.parse(input);
    return this.db.$transaction(async (tx) => {
      const created = await tx.property.create({ data: { ...data, tenantId: this.tenantId, currency: 'NGN' } });
      if (otherFees.length) await tx.propertyFee.createMany({ data: otherFees.map((fee) => ({
        ...fee, tenantId: this.tenantId, propertyId: created.id
      })) });
      const property = await this.propertyRecord(tx, created.id);
      await this.audit(tx, 'property.created', 'Property', property.id, propertyConfiguration(property));
      return propertyResponse(property);
    });
  }

  async updateProperty(propertyId: string, input: unknown) {
    this.permit('properties:write');
    const patch = updatePropertyBody.parse(input);
    return this.db.$transaction(async (tx) => {
      const current = await this.propertyRecord(tx, propertyId, true);
      const before = propertyConfiguration(current);
      // Validate changed fields and cross-field clock rules. Do not reject or rewrite
      // unrelated legacy text simply because current creation limits are stricter.
      const merged = { ...before, ...patch };
      propertyTimes.parse({ standardCheckIn: merged.standardCheckIn, standardCheckOut: merged.standardCheckOut,
        earlyCheckInFrom: merged.earlyCheckInFrom, lateCheckOutUntil: merged.lateCheckOutUntil });
      const { otherFees, ...data } = patch;
      await tx.property.update({ where: { id: propertyId, tenantId: this.tenantId }, data: { ...data, updatedAt: new Date() } });
      if (patch.otherFees !== undefined) {
        await tx.propertyFee.deleteMany({ where: { tenantId: this.tenantId, propertyId } });
        if (otherFees?.length) await tx.propertyFee.createMany({ data: otherFees.map((fee) => ({ ...fee, tenantId: this.tenantId, propertyId })) });
      }
      const property = await this.propertyRecord(tx, propertyId);
      const changes = configurationChanges(before, propertyConfiguration(property));
      if (Object.keys(changes.after).length) {
        const action = current.isActive && !property.isActive ? 'property.deactivated' : 'property.updated';
        await this.audit(tx, action, 'Property', propertyId, changes.after, changes.before);
      }
      return propertyResponse(property);
    });
  }

  private overlapWhere(startDate: string, endDate: string) {
    return { startDate: { lt: lagosMidnight(endDate) }, endDate: { gt: lagosMidnight(startDate) } };
  }

  async listBlocks(propertyId: string, query: unknown) {
    this.permit('properties:read');
    const parsed = calendarListQuery.parse(query);
    const range = validListRange(parsed);
    return this.db.$transaction(async (tx) => {
      await this.propertyRecord(tx, propertyId);
      const blocks = await tx.availabilityBlock.findMany({
        where: { tenantId: this.tenantId, propertyId, source: 'operator', ...(range ? this.overlapWhere(range.startDate, range.endDate) : {}) },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }], take: parsed.limit, skip: parsed.offset
      });
      return { blocks: blocks.map(blockResponse), limit: parsed.limit, offset: parsed.offset };
    });
  }

  async createBlock(propertyId: string, input: unknown) {
    this.permit('availability:write');
    const data = createBlockBody.parse(input);
    return this.db.$transaction(async (tx) => {
      const property = await this.propertyRecord(tx, propertyId, true);
      if (!property.isActive) throw new HttpError(409, 'PROPERTY_INACTIVE');
      const overlap = await tx.availabilityBlock.findFirst({ where: {
        tenantId: this.tenantId, propertyId, ...this.overlapWhere(data.startDate, data.endDate)
      }, select: { id: true } });
      if (overlap) throw new HttpError(409, 'BLOCK_OVERLAP');
      const requested = asDateRange(data);
      const now = new Date();
      const bookings = await occupyingBookings(tx, this.tenantId, propertyId, requested, now);
      if (!isDateRangeAvailable(requested, bookings, [], now)) throw new HttpError(409, 'BOOKING_OVERLAP');
      const block = await tx.availabilityBlock.create({ data: {
        tenantId: this.tenantId, propertyId, startDate: lagosMidnight(data.startDate),
        endDate: lagosMidnight(data.endDate), reason: data.reason, source: 'operator'
      } });
      const result = blockResponse(block);
      await this.audit(tx, 'availability.block.created', 'AvailabilityBlock', block.id, result);
      return result;
    }).catch((error: unknown) => integrityAlert(this.db, this.auth, propertyId, error));
  }

  async removeBlock(propertyId: string, blockId: string) {
    this.permit('availability:write');
    await this.db.$transaction(async (tx) => {
      await this.propertyRecord(tx, propertyId, true);
      const block = await tx.availabilityBlock.findFirst({ where: { id: blockId, tenantId: this.tenantId, propertyId, source: 'operator' } });
      if (!block) throw new HttpError(404, 'NOT_FOUND');
      await tx.availabilityBlock.delete({ where: { id: blockId, tenantId: this.tenantId, propertyId, source: 'operator' } });
      await this.audit(tx, 'availability.block.removed', 'AvailabilityBlock', blockId, {}, blockResponse(block));
    });
  }

  async listPriceOverrides(propertyId: string, query: unknown) {
    this.permit('properties:read');
    const parsed = calendarListQuery.parse(query);
    const range = validListRange(parsed);
    return this.db.$transaction(async (tx) => {
      await this.propertyRecord(tx, propertyId);
      const rules = await tx.priceRule.findMany({
        where: { tenantId: this.tenantId, propertyId, dayOfWeek: null,
          startDate: { not: null }, endDate: { not: null }, ...(range ? this.overlapWhere(range.startDate, range.endDate) : {}) },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }], take: parsed.limit, skip: parsed.offset
      });
      return { priceOverrides: rules.map(priceOverrideResponse), limit: parsed.limit, offset: parsed.offset };
    });
  }

  async createPriceOverride(propertyId: string, input: unknown) {
    this.permit('pricing:write');
    const data = createPriceOverrideBody.parse(input);
    return this.db.$transaction(async (tx) => {
      await this.propertyRecord(tx, propertyId, true);
      const overlap = await tx.priceRule.findFirst({ where: {
        tenantId: this.tenantId, propertyId, dayOfWeek: null, ...this.overlapWhere(data.startDate, data.endDate)
      }, select: { id: true } });
      if (overlap) throw new HttpError(409, 'PRICE_OVERRIDE_OVERLAP');
      const rule = await tx.priceRule.create({ data: {
        tenantId: this.tenantId, propertyId, label: data.label, nightlyPriceKobo: data.nightlyPriceKobo,
        startDate: lagosMidnight(data.startDate), endDate: lagosMidnight(data.endDate), dayOfWeek: null, priority: 0
      } });
      const result = priceOverrideResponse(rule);
      await this.audit(tx, 'pricing.override.created', 'PriceRule', rule.id, result);
      return result;
    });
  }

  async removePriceOverride(propertyId: string, ruleId: string) {
    this.permit('pricing:write');
    await this.db.$transaction(async (tx) => {
      await this.propertyRecord(tx, propertyId, true);
      const rule = await tx.priceRule.findFirst({ where: {
        id: ruleId, tenantId: this.tenantId, propertyId, dayOfWeek: null, startDate: { not: null }, endDate: { not: null }
      } });
      if (!rule) throw new HttpError(404, 'NOT_FOUND');
      await tx.priceRule.delete({ where: { id: ruleId, tenantId: this.tenantId, propertyId, dayOfWeek: null } });
      await this.audit(tx, 'pricing.override.removed', 'PriceRule', ruleId, {}, priceOverrideResponse(rule));
    });
  }

  async availability(propertyId: string, query: unknown) {
    this.permit('properties:read');
    const { checkIn, checkOut } = availabilityQuery.parse(query);
    return this.db.$transaction(async (tx) => {
      const property = await this.propertyRecord(tx, propertyId);
      const requested = asDateRange({ startDate: checkIn, endDate: checkOut });
      const now = new Date();
      const blocks = await tx.availabilityBlock.findMany({ where: {
        tenantId: this.tenantId, propertyId, ...this.overlapWhere(checkIn, checkOut)
      }, select: { startDate: true, endDate: true } });
      const bookings = await occupyingBookings(tx, this.tenantId, propertyId, requested, now);
      const rules = await tx.priceRule.findMany({ where: {
        tenantId: this.tenantId, propertyId,
        AND: [{ OR: [{ startDate: null }, { startDate: { lt: requested.checkOut } }] },
          { OR: [{ endDate: null }, { endDate: { gt: requested.checkIn } }] }]
      } });
      const calendarAvailable = isDateRangeAvailable(requested, bookings,
        blocks.map((block) => ({ checkIn: block.startDate, checkOut: block.endDate })), now);
      const nights = nightsBetween(checkIn, checkOut);
      const minimumStayMet = nights >= property.minimumStayNights;
      return {
        propertyId, timezone: BOOKING_TIMEZONE, checkIn, checkOut, nights, checkedAt: now.toISOString(),
        available: property.isActive && minimumStayMet && calendarAvailable,
        calendarAvailable, minimumStayMet, minimumStayNights: property.minimumStayNights, isActive: property.isActive,
        nightlyPrices: nightlyPrices(checkIn, checkOut, property, rules)
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
      .catch((error: unknown) => integrityAlert(this.db, this.auth, propertyId, error));
  }

  private audit(tx: Prisma.TransactionClient, action: string, entityType: string, entityId: string, after: Prisma.InputJsonObject, before?: Prisma.InputJsonObject) {
    return tx.auditLog.create({ data: {
      tenantId: this.tenantId, actorId: this.auth.user.id, actorType: 'USER', action, entityType, entityId, after, before
    } });
  }
}
