import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';

const ROLE_PERMISSIONS: Record<string, string[]> = {
  'activity-owner': [
    'activity.update.record',
    'activity.cancel.record',
    'activity.complete.record',
    'activity-registration.read.record',
    'activity-registration.create.record',
    'activity-registration.approve.record',
    'activity-registration.reject.record',
    'activity-registration.cancel.record',
    'activity-registration.reopen.record',
    'attendance.read.sheet',
    'attendance.create.sheet',
    'attendance.update.sheet',
    'attendance.delete.sheet',
  ],
  'activity-registration-collaborator': [
    'activity-registration.read.record',
    'activity-registration.create.record',
    'activity-registration.approve.record',
    'activity-registration.reject.record',
    'activity-registration.cancel.record',
    'activity-registration.reopen.record',
  ],
  'activity-attendance-collaborator': [
    'attendance.read.sheet',
    'attendance.create.sheet',
    'attendance.update.sheet',
    'attendance.delete.sheet',
  ],
};

export async function seedActivityResponsibilitySystemRoles(
  app: INestApplication,
): Promise<Record<string, string>> {
  const prisma = app.get(PrismaService);
  const permissionCodes = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];
  await prisma.permission.createMany({
    data: permissionCodes.map((code) => {
      const [resourceType, action] = code.split('.');
      return {
        code,
        module: resourceType,
        action: action ?? 'manage',
        resourceType,
      };
    }),
    skipDuplicates: true,
  });
  const permissions = await prisma.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true, code: true },
  });
  const permissionIds = new Map(permissions.map((permission) => [permission.code, permission.id]));
  const roleIds: Record<string, string> = {};
  for (const [code, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.rbacRole.upsert({
      where: { code },
      create: { code, displayName: code },
      update: { deletedAt: null },
      select: { id: true },
    });
    roleIds[code] = role.id;
    await prisma.rolePermission.createMany({
      data: codes.map((permissionCode) => ({
        roleId: role.id,
        permissionId: permissionIds.get(permissionCode)!,
      })),
      skipDuplicates: true,
    });
  }
  return roleIds;
}
