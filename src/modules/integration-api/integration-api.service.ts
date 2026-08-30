import { Injectable } from '@nestjs/common';

import type { IntegrationPrincipalContext } from '../../common/decorators/current-integration-principal.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { IntegrationMeResponseDto } from './integration-api.dto';

@Injectable()
export class IntegrationApiService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(principal: IntegrationPrincipalContext): Promise<IntegrationMeResponseDto> {
    const servicePrincipal = await this.prisma.servicePrincipal.findFirst({
      where: {
        id: principal.servicePrincipalId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { clientId: true, name: true },
    });
    if (servicePrincipal === null) throw new BizException(BizCode.INTEGRATION_TOKEN_INVALID);

    return {
      principalKind: principal.kind,
      servicePrincipal,
      delegated: principal.kind === 'DELEGATED',
    };
  }
}
