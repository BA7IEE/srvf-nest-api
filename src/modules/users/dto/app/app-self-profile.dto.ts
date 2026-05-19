import { ApiProperty } from '@nestjs/swagger';
import { MemberStatus } from '@prisma/client';

// Phase 2 P2-2 App /me/profile GET / PATCH 共用出参。
// 沿 docs/app-api-p2-2-profile-review.md §2.4 v0.1 字段集**恰好 9 个**;
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO(沿 Phase 0.7 §2.2 + Phase 2 review §5.2 #1)。
// 不含 MemberProfile 任何字段(P2-2 v0.1 收窄;沿 §2.3 决议);
// 不含 email(由 /api/app/v1/me/account 承载);
// 不含 medical / emergency contacts / organization / department / role / permissions /
// gradeCode / joinedDate / realName / mobileMasked / documentNumberMasked / canUseApp / appAccessReason。
export class AppSelfProfileDto {
  @ApiProperty({ description: '当前登录用户 id', example: 'cl9z3a8b00000abcd1234efgh' })
  userId!: string;

  @ApiProperty({
    description: '已绑定 member id(canUseApp=true 时非空)',
    example: 'cl9z3a8b00000mxxxxxxxxxx',
  })
  memberId!: string;

  @ApiProperty({ description: '账号名(归一化后小写)', example: 'volunteer001' })
  username!: string;

  @ApiProperty({ description: '昵称', nullable: true, example: '阿明' })
  nickname!: string | null;

  @ApiProperty({
    description: '头像 attachment key(不返 signed URL)',
    nullable: true,
    example: 'user/avatars/clxxx.png',
  })
  avatarKey!: string | null;

  @ApiProperty({ description: '队员编号(终身不变)', example: 'V0001' })
  memberNo!: string;

  @ApiProperty({ description: '队员展示名', example: '王小明' })
  displayName!: string;

  @ApiProperty({
    description: '队员状态(P2-2 进入时强约 ACTIVE)',
    enum: MemberStatus,
    example: MemberStatus.ACTIVE,
  })
  memberStatus!: MemberStatus;

  @ApiProperty({
    description: '是否已有 MemberProfile 档案(派生;单字段 select)',
    example: true,
  })
  hasMemberProfile!: boolean;
}
