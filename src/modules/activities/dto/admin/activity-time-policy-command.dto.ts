import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsString,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { TimePolicyDefinitionDto } from './activity-time-policy.dto';

export class AdminCreateTimePolicyDto {
  @ApiProperty({ description: '幂等操作标识', minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  operationKey!: string;
  @ApiProperty({ description: '稳定政策代码', pattern: '^[a-z][a-z0-9_]{0,63}$' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/u)
  code!: string;
  @ApiProperty({ description: '政策名称', minLength: 1, maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name!: string;
}
export class AdminCreateTimePolicyVersionDto {
  @ApiProperty({ description: '幂等操作标识', minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  operationKey!: string;
  @ApiProperty({ description: '结构版本', enum: [1] })
  @Equals(1)
  schemaVersion!: number;
  @ApiProperty({ description: '解释器版本', enum: [1] })
  @Equals(1)
  evaluatorVersion!: number;
  @ApiProperty({
    description: '闭合政策定义，canonical UTF8最多32768字节',
    type: TimePolicyDefinitionDto,
  })
  @ValidateNested()
  @Type(() => TimePolicyDefinitionDto)
  definition!: TimePolicyDefinitionDto;
  @ApiProperty({ description: '生效开始，UTC毫秒ISO文本', example: '2026-01-01T00:00:00.000Z' })
  @IsString()
  effectiveFrom!: string;
  @ApiProperty({
    description: '生效结束，UTC毫秒ISO文本；无终点显式null',
    type: String,
    nullable: true,
  })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  effectiveUntil!: string | null;
}
export class AdminActivateTimePolicyVersionDto {
  @ApiProperty({ description: '幂等操作标识', minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  operationKey!: string;
  @ApiProperty({ description: '期望的版本摘要', pattern: '^[a-f0-9]{64}$' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/u)
  expectedDefinitionHash!: string;
  @ApiProperty({ description: '期望状态', enum: ['draft'] })
  @IsIn(['draft'])
  expectedStatusCode!: string;
}
export class AdminRetireTimePolicyVersionDto {
  @ApiProperty({ description: '幂等操作标识', minLength: 1, maxLength: 128 })
  @IsString()
  @Length(1, 128)
  operationKey!: string;
  @ApiProperty({ description: '期望的版本摘要', pattern: '^[a-f0-9]{64}$' })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/u)
  expectedDefinitionHash!: string;
  @ApiProperty({ description: '期望状态', enum: ['active'] })
  @IsIn(['active'])
  expectedStatusCode!: string;
}
export class AdminTimePolicyCommandResponseDto {
  @ApiProperty({ description: '收据结构版本', enum: [1] })
  schemaVersion!: number;
  @ApiProperty({
    description: '命令类型',
    enum: ['create_policy', 'create_version', 'activate_version', 'retire_version'],
  })
  operationCode!: string;
  @ApiProperty({ description: '政策ID' })
  policyId!: string;
  @ApiProperty({ description: '版本ID', type: String, nullable: true })
  versionId!: string | null;
  @ApiProperty({ description: '版本摘要', type: String, nullable: true })
  definitionHash!: string | null;
  @ApiProperty({
    description: '原始命令结果状态',
    type: String,
    nullable: true,
    enum: ['draft', 'active', 'retired'],
  })
  resultStatusCode!: string | null;
  @ApiProperty({ description: '原始命令结果时间' })
  createdAt!: string;
}
