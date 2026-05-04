import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

// @Roles(Role.SUPER_ADMIN, Role.ADMIN) 标注允许进入接口的角色。
// RolesGuard 在第 7 阶段接入 auth 时注册,本阶段先把元数据契约定好。
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
