import { Injectable } from '@nestjs/common';
import type {
  CertificateIssuerPolicy,
  CertificateNumberMode,
  CertificateRecognitionPolicyStatus,
  CertificateStandardKind,
  CertificateStandardStatus,
  CertificateValidityMode,
  Prisma,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 证书标准库 PR-3(冻结稿 §17):Standard / Policy 变更的审计记录器。
//
// **与既有配置面范式的一处有意偏离**:positions / dictionaries 等配置面
// 明确「不落 audit」。Standard / Policy 落 —— 因为它们不是普通配置:
// 一次 Policy 激活会改变**此后所有新证书**的认定依据(编号是否必填、
// 有效期怎么算、认可哪些机构),而已锁定的历史证书又必须保持不变(D-CERT-008)。
// 「谁在什么时候把哪版规则切上去了」是事后唯一能复原判断依据的线索。
// §17 因此把这两个事件列为高价值事件。
//
// 快照口径(§17 允许清单,逐字):code / name / kind / categoryCode / levelCode /
// parentId / isInternal / status / policyVersion / issuerPolicy / issuerNames /
// validityMode / validityMonths / certNumberMode。
// Standard 与 Policy 本身不含 L2/L3 数据(编号、图片、备注、申请人 PII 都不在这两张表),
// 所以这里天然无泄露面;仍显式列字段而不是整行 spread —— 将来加了敏感列
// 也不会被 spread 顺手带进不可变审计(§15.6)。

export interface StandardAuditSnapshot {
  code: string;
  name: string;
  kind: CertificateStandardKind;
  categoryCode: string;
  levelCode: string | null;
  parentId: string | null;
  isInternal: boolean;
  status: CertificateStandardStatus;
  sortOrder: number;
}

export interface PolicyAuditSnapshot {
  standardId: string;
  policyVersion: number;
  status: CertificateRecognitionPolicyStatus;
  issuerPolicy: CertificateIssuerPolicy;
  validityMode: CertificateValidityMode;
  validityMonths: number | null;
  certNumberMode: CertificateNumberMode;
  issuerNames: string[];
}

// 闭集 operation(§17):Standard 与 Policy 两个事件靠 extra.operation 区分具体动作。
export type StandardAuditOperation = 'create' | 'update' | 'activate' | 'deactivate' | 'delete';
export type PolicyAuditOperation =
  | 'create-policy'
  // 评审 findings F5(R8):改 DRAFT 规则此前复用 `create-policy` —— 审计里
  // 建版与改版长得一模一样,事后根本分不出「这一版是新建的」还是「被改过」。
  | 'update-draft-policy'
  | 'activate-policy'
  | 'retire-policy'
  | 'replace-draft-issuers'
  | 'delete';

@Injectable()
export class CertificateStandardAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  toStandardSnapshot(row: {
    code: string;
    name: string;
    kind: CertificateStandardKind;
    categoryCode: string;
    levelCode: string | null;
    parentId: string | null;
    isInternal: boolean;
    status: CertificateStandardStatus;
    sortOrder: number;
  }): StandardAuditSnapshot {
    return {
      code: row.code,
      name: row.name,
      kind: row.kind,
      categoryCode: row.categoryCode,
      levelCode: row.levelCode,
      parentId: row.parentId,
      isInternal: row.isInternal,
      status: row.status,
      sortOrder: row.sortOrder,
    };
  }

  toPolicySnapshot(
    row: {
      standardId: string;
      version: number;
      status: CertificateRecognitionPolicyStatus;
      issuerPolicy: CertificateIssuerPolicy;
      validityMode: CertificateValidityMode;
      validityMonths: number | null;
      certNumberMode: CertificateNumberMode;
    },
    issuerNames: string[],
  ): PolicyAuditSnapshot {
    return {
      standardId: row.standardId,
      policyVersion: row.version,
      status: row.status,
      issuerPolicy: row.issuerPolicy,
      validityMode: row.validityMode,
      validityMonths: row.validityMonths,
      certNumberMode: row.certNumberMode,
      // canonical 机构名可写(§17 明确 issuer 可写 canonical 名称);
      // 机构名不是个人信息,是队内主数据。
      issuerNames,
    };
  }

  async recordStandardChange(input: {
    currentUser: CurrentUserPayload;
    meta: AuditMeta;
    standardId: string;
    operation: StandardAuditOperation;
    before?: StandardAuditSnapshot;
    after?: StandardAuditSnapshot;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'certificate-standard.change',
      actorUserId: input.currentUser.id,
      actorRoleSnap: input.currentUser.role,
      resourceType: 'certificate_standard',
      resourceId: input.standardId,
      meta: input.meta,
      ...(input.before ? { before: { ...input.before } } : {}),
      ...(input.after ? { after: { ...input.after } } : {}),
      extra: { operation: input.operation },
      tx: input.tx,
    });
  }

  async recordPolicyChange(input: {
    currentUser: CurrentUserPayload;
    meta: AuditMeta;
    policyId: string;
    operation: PolicyAuditOperation;
    before?: PolicyAuditSnapshot;
    after?: PolicyAuditSnapshot;
    /**
     * 激活时被**自动退役**的那一版(评审 findings F5 · R8)。
     * 只记 id 与 version 两个闭集标识 —— 规则内容已经在被退役那一版自己的
     * 审计快照里,这里重复一遍只会让同一事实有两个副本。
     */
    supersededPolicy?: { id: string; version: number } | null;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'certificate-recognition-policy.change',
      actorUserId: input.currentUser.id,
      actorRoleSnap: input.currentUser.role,
      resourceType: 'certificate_recognition_policy',
      resourceId: input.policyId,
      meta: input.meta,
      ...(input.before ? { before: { ...input.before } } : {}),
      ...(input.after ? { after: { ...input.after } } : {}),
      extra: {
        operation: input.operation,
        ...(input.supersededPolicy
          ? {
              supersededPolicyId: input.supersededPolicy.id,
              supersededPolicyVersion: input.supersededPolicy.version,
            }
          : {}),
      },
      tx: input.tx,
    });
  }
}
