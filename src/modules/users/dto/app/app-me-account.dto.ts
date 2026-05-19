import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import type { AppAccessReason } from './app-access-reason';

// Phase 2 P2-1 App /me/account 出参。沿 docs/app-api-phase-2-review.md §5.1 表 2 行 2。
// **严禁**继承 / Pick / Omit Admin DTO;**不**返 role(account 视角不暴露 role / 沿 D-5.2);
// **不**返 deletedAt / L3 字段;linkedMemberId 表 memberLinked 标志(null 即未绑)。
export class AppMeAccountDto {
  @ApiProperty({ description: '当前登录用户 id', example: 'cl9z3a8b00000abcd1234efgh' })
  userId!: string;

  @ApiProperty({ description: '账号名(归一化后小写)', example: 'volunteer001' })
  username!: string;

  @ApiProperty({ description: '邮箱(可空)', example: 'volunteer@example.com', nullable: true })
  email!: string | null;

  @ApiProperty({ description: '账号状态', enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({
    description: '最近登录时间 ISO(可空)',
    example: '2026-05-19T12:34:56.000Z',
    nullable: true,
  })
  lastLoginAt!: string | null;

  @ApiProperty({
    description: '已绑定 member id(null 即未绑定)',
    example: 'cl9z3a8b00000mxxxxxxxxxx',
    nullable: true,
  })
  linkedMemberId!: string | null;

  @ApiProperty({ description: '是否可使用 App 队员功能', example: true })
  canUseApp!: boolean;

  @ApiProperty({
    description: 'App 不可用原因(展示字符串;非 BizCode)',
    enum: ['MEMBER_NOT_LINKED', 'MEMBER_INACTIVE', 'MEMBER_DELETED'],
    nullable: true,
    example: null,
  })
  appAccessReason!: AppAccessReason | null;
}
