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

  // ⚠️ issue #1048 T1 的命名冲突处置:本 DTO 是**扁平**结构,`nickname` 已被
  // 登录账号昵称(`User.nickname`)占用,队内外号(`Member.nickname`)不能同名平铺。
  // 故此处只出 `realName` + 统一标签 `memberLabel`(标签里已经含外号),
  // 不再单独平铺队员外号 —— 两个 nickname 挤在一层是必然被人读错的形状。
  @ApiProperty({ description: '队员真实姓名(未绑定时为 null)', example: '王小明', nullable: true })
  realName!: string | null;

  @ApiProperty({
    description: '统一展示标签 `编号 · 姓名(外号)`(未绑定时为 null)',
    example: 'V0001 · 王小明(小明)',
    nullable: true,
  })
  memberLabel!: string | null;

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
