import { Prisma } from '@prisma/client';

/** Existing service-hour precision: two decimal places, half up. */
export function roundServiceHours(hours: Prisma.Decimal): Prisma.Decimal {
  return hours.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
