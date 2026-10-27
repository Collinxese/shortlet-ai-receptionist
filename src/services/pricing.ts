import type { PriceRule } from '@prisma/client';
import { DAY_MS, lagosDate, lagosMidnight } from './calendar.js';

type Pricing = { baseNightlyPriceKobo: bigint; weekendNightlyPriceKobo: bigint | null };
type Rule = Pick<PriceRule, 'id' | 'startDate' | 'endDate' | 'dayOfWeek' | 'nightlyPriceKobo' | 'priority'>;

/** Read-only nightly rates. No booking, charge, hold or binding quote is created. */
export function nightlyPrices(startDate: string, endDate: string, property: Pricing, rules: Rule[]) {
  const ranked = [...rules].sort((a, b) => b.priority - a.priority ||
    Number(b.dayOfWeek === null) - Number(a.dayOfWeek === null) || a.id.localeCompare(b.id));
  const result = [];
  const end = lagosMidnight(endDate).getTime();
  for (let time = lagosMidnight(startDate).getTime(); time < end; time += DAY_MS) {
    const date = lagosDate(new Date(time));
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const rule = ranked.find((item) =>
      (item.dayOfWeek === null || item.dayOfWeek === day) &&
      (!item.startDate || lagosDate(item.startDate) <= date) &&
      (!item.endDate || lagosDate(item.endDate) > date));
    const weekend = day === 5 || day === 6; // Friday and Saturday nights.
    const amount = rule?.nightlyPriceKobo ?? (weekend ? property.weekendNightlyPriceKobo : null) ?? property.baseNightlyPriceKobo;
    result.push({ date, nightlyPriceKobo: Number(amount), source: rule ? 'price-rule' :
      weekend && property.weekendNightlyPriceKobo !== null ? 'weekend' : 'weekday' });
  }
  return result;
}
