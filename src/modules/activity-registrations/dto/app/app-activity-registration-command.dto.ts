import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import {
  IsArray,
  IsDefined,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class AppActivityRegistrationAnswerCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  fieldCode!: string;

  @ApiPropertyOptional({
    description: '除 file 题外的原始答案；类型、范围及选项由冻结表单在服务端校验',
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: {} },
      { type: 'object', additionalProperties: true },
    ],
  })
  @OmittableOnly()
  @IsDefined()
  value?: unknown;

  @ApiPropertyOptional({
    description: '仅 file 题接受的一次性上传会话 id；不接受 attachmentId、token、key 或 URL',
    minLength: 8,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  uploadSessionId?: string;
}

export class AppActivityRegistrationPreferenceCommandDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string;

  @ApiProperty({ type: [String], description: '按数组顺序派生服务端 preferenceOrder（从 1 开始）' })
  @IsArray()
  @IsString({ each: true })
  @MinLength(8, { each: true })
  @MaxLength(64, { each: true })
  positionIds!: string[];
}

export class AppActivityRegistrationCommandDto {
  @ApiProperty({ minLength: 1, maxLength: 128, description: '调用方生成的幂等操作键' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  operationKey!: string;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 2147483647 })
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  formVersion!: number | null;

  @ApiProperty({ type: [AppActivityRegistrationAnswerCommandDto] })
  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppActivityRegistrationAnswerCommandDto)
  answers!: AppActivityRegistrationAnswerCommandDto[];

  @ApiProperty({ type: [AppActivityRegistrationPreferenceCommandDto] })
  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppActivityRegistrationPreferenceCommandDto)
  preferences!: AppActivityRegistrationPreferenceCommandDto[];
}
