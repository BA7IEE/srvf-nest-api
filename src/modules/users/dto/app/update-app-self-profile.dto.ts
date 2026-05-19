import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Phase 2 P2-2 App PATCH /me/profile 入参。
// 沿 docs/app-api-p2-2-profile-review.md §3 严格 2 字段白名单;
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO;
// **严禁**夹带 Member 业务 / Emergency contacts / Organization / Department / Role /
// Permission / Account / 审批字段(沿 §3.3);全局 ValidationPipe `forbidNonWhitelisted: true`
// 兜底,DTO 自身白名单是第一道防线(沿 CLAUDE.md §11)。
export class UpdateAppSelfProfileDto {
  @ApiPropertyOptional({ description: '昵称', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 attachment key', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  avatarKey?: string;
}
