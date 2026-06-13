import { ApiProperty } from '@nestjs/swagger';
import { Role, UserStatus } from '@prisma/client';

// Admin surface 本人身份只读 bootstrap 出参(GET /api/admin/v1/me;2026-06-14)。
// 字段集 = User 本体身份**恰好 9 项**(沿 goal D2:只返身份,不内联角色/权限)。
//
// 边界(独立定义,**严禁**继承 / Pick / Omit / PartialType / IntersectionType 任何既有 DTO
// 含 AppMeResponseDto / UserResponseDto;沿 api-surface-policy §2.1 四 surface DTO 物理隔离):
//   - **不**返 member 业务字段(memberNo / displayName / gradeCode / memberStatus 属 App 自视角,§9.3);
//     仅返 memberId(User 本体外键,表"是否已绑")。
//   - **不**返 raw RBAC permission code(§9.4);权限永远走 GET /api/system/v1/rbac/me/permissions。
//   - **永不**返 L3 字段(passwordHash / refreshToken / tokenHash / secret*)。
//   - role / status 仅作前台 UI 展示(本人;非授权依据),沿 AppMeResponseDto role 同语义。
export class AdminMeResponseDto {
  @ApiProperty({ description: '当前登录用户 id', example: 'cl9z3a8b00000abcd1234efgh' })
  userId!: string;

  @ApiProperty({ description: '账号名(归一化后小写)', example: 'admin001' })
  username!: string;

  @ApiProperty({ description: '邮箱(可空)', example: 'admin@example.com', nullable: true })
  email!: string | null;

  @ApiProperty({ description: '昵称(可空)', example: '管理员小王', nullable: true })
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
    description: '最近登录时间 ISO(可空)',
    example: '2026-06-14T12:34:56.000Z',
    nullable: true,
  })
  lastLoginAt!: string | null;

  @ApiProperty({
    description: '已绑定 member id(未绑定时为 null;不返 member 业务字段)',
    example: 'cl9z3a8b00000mxxxxxxxxxx',
    nullable: true,
  })
  memberId!: string | null;
}
