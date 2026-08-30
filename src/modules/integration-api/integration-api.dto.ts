import { ApiProperty } from '@nestjs/swagger';

export class IntegrationServicePrincipalDto {
  @ApiProperty({ example: 'srvf_sp_example' })
  clientId!: string;

  @ApiProperty({ example: '外部协作系统' })
  name!: string;
}

export class IntegrationMeResponseDto {
  @ApiProperty({ enum: ['SERVICE', 'DELEGATED'] })
  principalKind!: 'SERVICE' | 'DELEGATED';

  @ApiProperty({ type: IntegrationServicePrincipalDto })
  servicePrincipal!: IntegrationServicePrincipalDto;

  @ApiProperty()
  delegated!: boolean;
}
