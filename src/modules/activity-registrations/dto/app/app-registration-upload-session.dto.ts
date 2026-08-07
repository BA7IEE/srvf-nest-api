import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class AppRegistrationUploadSessionActivityParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  activityId!: string;
}

export class AppRegistrationUploadSessionFileParamsDto extends AppRegistrationUploadSessionActivityParamsDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;
}

/** The raw token is returned exactly once by session creation and is never persisted or replayed. */
export class AppRegistrationUploadSessionCreatedDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: '一次性原始 token；仅本次创建响应返回' })
  token!: string;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ minimum: 1 })
  formVersion!: number;
}

/** Safe terminal metadata; no key, URL, owner or storage locator is ever exposed. */
export class AppRegistrationUploadAttachmentDto {
  @ApiProperty()
  attachmentId!: string;

  @ApiProperty()
  originalName!: string;

  @ApiProperty()
  mime!: string;

  @ApiProperty()
  size!: number;

  @ApiProperty()
  createdAt!: Date;
}
