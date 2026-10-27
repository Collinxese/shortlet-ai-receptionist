import { z } from 'zod';

export const BOOKING_TIMEZONE = 'Africa/Lagos';
export const DAY_MS = 86_400_000;
export const MAX_STAY_NIGHTS = 366;

// Lagos is UTC+01:00 throughout this explicitly supported modern period.
export const calendarDate = z.iso.date().refine((value) => value >= '2000-01-01' && value <= '2199-12-31');

export function lagosMidnight(date: string): Date {
  return new Date(`${calendarDate.parse(date)}T00:00:00+01:00`);
}

export function lagosDate(date: Date): string {
  return new Date(date.getTime() + 3_600_000).toISOString().slice(0, 10);
}

/** Stored ranges can span outside the public API's date window. Do not revalidate
 * their endpoints as new user input when normalizing an existing booking. */
export function lagosDayStart(instant: Date): Date {
  const local = new Date(instant.getTime() + 3_600_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - 3_600_000);
}

export function nightsBetween(startDate: string, endDate: string): number {
  return (lagosMidnight(endDate).getTime() - lagosMidnight(startDate).getTime()) / DAY_MS;
}

export const calendarRange = z.strictObject({ startDate: calendarDate, endDate: calendarDate })
  .refine(({ startDate, endDate }) => {
    if (!calendarDate.safeParse(startDate).success || !calendarDate.safeParse(endDate).success) return false;
    const nights = nightsBetween(startDate, endDate);
    return nights > 0 && nights <= MAX_STAY_NIGHTS;
  });

export function asDateRange(range: z.infer<typeof calendarRange>) {
  return { checkIn: lagosMidnight(range.startDate), checkOut: lagosMidnight(range.endDate) };
}
