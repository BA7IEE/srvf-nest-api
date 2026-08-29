import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DelegationGrantsModule } from '../delegation-grants/delegation-grants.module';
import { ServicePrincipalsModule } from '../service-principals/service-principals.module';
import { IntegrationAuthGate } from './integration-auth.gate';
import { DelegatedTokenController } from './delegated-token.controller';
import { ServiceTokenController } from './service-token.controller';
import { DelegatedTokenService } from './delegated-token.service';
import { ServiceTokenService } from './service-token.service';

/**
 * Integration Foundation v1 PR3(规格书 §41/§59):机器认证与短期 Token。
 *
 * - `POST auth/v1/service-token`(Client Credentials;§12.3 冻结接口)
 * - 独立 JWT secret/issuer/audience(§11.2;与真人 JWT 不同信任域)
 * - Feature Gate `INTEGRATION_API_ENABLED`(§48;false 时 token 签发 37030 fail-closed)
 * - Delegated Token 是 PR5;IntegrationJwtAuthGuard / Integration Surface 是 PR4/PR6
 *
 * ⚠️ 本模块**不注册自己的 JwtModule** —— JwtModule 是全局单例,空注册会把 auth 模块的
 * 密钥配置整个覆盖(auth-jwt-guard e2e 实测全挂:secretOrPrivateKey must have a value)。
 * ServiceTokenService 每次 sign/verify 都显式传 integration secret,复用全局 JwtService
 * 的编解码原语即可,不碰实例默认值。
 */
@Module({
  imports: [DatabaseModule, ServicePrincipalsModule, DelegationGrantsModule, AuditLogsModule],
  controllers: [ServiceTokenController, DelegatedTokenController],
  providers: [IntegrationAuthGate, ServiceTokenService, DelegatedTokenService],
  exports: [IntegrationAuthGate, ServiceTokenService, DelegatedTokenService],
})
export class IntegrationAuthModule {}
