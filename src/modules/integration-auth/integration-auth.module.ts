import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { DatabaseModule } from '../../database/database.module';
import { ServicePrincipalsModule } from '../service-principals/service-principals.module';
import { IntegrationAuthGate } from './integration-auth.gate';
import { ServiceTokenController } from './service-token.controller';
import { ServiceTokenService } from './service-token.service';

/**
 * Integration Foundation v1 PR3(规格书 §41/§59):机器认证与短期 Token。
 *
 * - `POST auth/v1/service-token`(Client Credentials;§12.3 冻结接口)
 * - 独立 JWT secret/issuer/audience(§11.2;与真人 JWT 不同信任域)
 * - Feature Gate `INTEGRATION_API_ENABLED`(§48;false 时 token 签发 37030 fail-closed)
 * - Delegated Token 是 PR5;IntegrationJwtAuthGuard / Integration Surface 是 PR4/PR6
 */
@Module({
  imports: [DatabaseModule, JwtModule.register({}), ServicePrincipalsModule],
  controllers: [ServiceTokenController],
  providers: [IntegrationAuthGate, ServiceTokenService],
  exports: [IntegrationAuthGate, ServiceTokenService],
})
export class IntegrationAuthModule {}
