import { Prisma } from '@prisma/client';

/** 证书相关 JSON 对象写库归一：空对象落 SQL NULL，非空对象保留 JSON。 */
export function certificateJsonOrDbNull(value: Record<string, unknown>) {
  return Object.keys(value).length > 0 ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}
