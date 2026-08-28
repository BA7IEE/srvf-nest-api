import { Module } from '@nestjs/common';

/**
 * Integration Foundation v1 — PR1 的**属主占位模块**(规格书 §41;T0 冻结稿 §8)。
 *
 * PR1 是纯 schema 刀:五张新表(ServicePrincipal 族 / DelegationGrant 族 /
 * IntegrationCommandReceipt)零运行时、零 Controller —— 但 domain-map 要求每个
 * Prisma 模型有真实存在的属主模块,故建此空壳承载归属。**不注册进 AppModule**
 * (零 provider、零路由,加载无意义);PR2 起按规格书 §41 拆出
 * service-principals / delegation-grants / integration-auth / integration-idempotency
 * 四个实体模块并迁走模型归属,本模块随之退役或转纯类型聚合。
 */
@Module({})
export class IntegrationFoundationModule {}
