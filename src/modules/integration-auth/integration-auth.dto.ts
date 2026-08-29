import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** POST auth/v1/delegated-token 的唯一 Body 字段；禁止任何 subject/user 字段。 */
export class DelegatedTokenRequestDto {
  @ApiProperty({ description: '由控制面创建的 DelegationGrant.id' })
  @IsString()
  @Length(8, 64)
  delegationGrantId!: string;
}

/** Service / Delegated Token 共用的统一包装 data 形状。 */
export class IntegrationTokenResponseDto {
  @ApiProperty({ description: '短期 Integration JWT；不含 refresh token' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: '有效期（秒）', minimum: 1, maximum: 1800 })
  expiresIn!: number;
}
