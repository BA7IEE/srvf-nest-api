import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// 标注接口为公开,跳过 JwtAuthGuard。与 @Roles(...) 互斥(详见 ARCHITECTURE.md §7.6)。
// JwtAuthGuard / RolesGuard 在第 7 阶段接入 auth 时才注册,本阶段先把元数据契约定好。
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
