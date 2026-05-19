import { ApiProperty } from '@nestjs/swagger';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import type { AppAccessReason } from './app-access-reason';

// Phase 2 P2-1 App /me 出参。沿 docs/app-api-phase-2-review.md §5.1 + §6.1;
// 字段集上限 L0 + L1(本人);**严禁**继承 / Pick / Omit / Mapped Types Admin DTO。
// L3 字段(passwordHash / refreshToken / tokenHash / secret*)永不出现。
// role 仅作前端 UI hint(L1 本人;沿 Phase 0.6 §2.2 #2.18),**非授权依据**;
// **不**返 raw RBAC permission code(沿 D-5.3);capability 走 /me/capabilities。
export class AppMeResponseDto {
  @ApiProperty({ description: '当前登录用户 id', example: 'cl9z3a8b00000abcd1234efgh' })
  userId!: string;

  @ApiProperty({ description: '账号名(归一化后小写)', example: 'volunteer001' })
  username!: string;

  @ApiProperty({ description: '邮箱(可空)', example: 'volunteer@example.com', nullable: true })
  email!: string | null;

  @ApiProperty({ description: '昵称(可空)', example: '小王', nullable: true })
  nickname!: string | null;

  @ApiProperty({
    description: '头像 attachment key(可空;不返完整 signed URL)',
    example: 'user/avatars/clxxx.png',
    nullable: true,
  })
  avatarKey!: string | null;

  @ApiProperty({ description: '系统角色(仅 UI 展示;非授权依据)', enum: Role })
  role!: Role;

  @ApiProperty({ description: '账号状态', enum: UserStatus })
  status!: UserStatus;

  @ApiProperty({
    description: '已绑定 member id(未绑定时为 null)',
    example: 'cl9z3a8b00000mxxxxxxxxxx',
    nullable: true,
  })
  memberId!: string | null;

  @ApiProperty({
    description: '已绑定队员编号(终身不变;未绑定时为 null)',
    example: 'V0001',
    nullable: true,
  })
  memberNo!: string | null;

  @ApiProperty({ description: '队员展示名(未绑定时为 null)', example: '王小明', nullable: true })
  displayName!: string | null;

  @ApiProperty({
    description: '队员等级字典 code(未绑定时为 null)',
    example: 'L1',
    nullable: true,
  })
  gradeCode!: string | null;

  @ApiProperty({ description: '队员状态(未绑定时为 null)', enum: MemberStatus, nullable: true })
  memberStatus!: MemberStatus | null;

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
