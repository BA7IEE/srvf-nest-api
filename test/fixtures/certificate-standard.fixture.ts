import type { PrismaService } from '../../src/database/prisma.service';

// 证书标准库 PR-4b 共享夹具。
//
// 冻结稿 §5.6 末条:「**任何**测试 fixture 或直接 Prisma 写都必须提供 Standard 和 Policy」。
// PR-4b 把 `Certificate.standardId / recognitionPolicyId / sourceCode` 收紧为 NOT NULL,
// 于是这条从「应该」变成「DB 层强制」—— 十四个 spec 里每一处直插证书都需要一对 id。
//
// 做成一个共享夹具而不是让每个 spec 各写一份:
//   ① 十四份拷贝迟早分叉,而它们都在描述同一件事(「一个能建证的最小标准」);
//   ② 认定规则的各种组合有专门的 certificate-standards.e2e / certificates.e2e 覆盖,
//      其余 spec 只需要「能过审的最宽松一条」,不该被迫理解 issuerPolicy 三态;
//   ③ 将来规则模型再变(比如加一种 validityMode),只改这一处。
//
// 默认规则刻意最宽松:FREE_TEXT 机构(传自由文本即可)+ EXPLICIT_OPTIONAL 有效期
// (到期日可传可不传)+ OPTIONAL 编号(可空)。任何一处收紧都会让无关 spec 无谓地红。

export interface SeededCertificateStandard {
  standardId: string;
  policyId: string;
  /** 直插 Certificate 时展开即可:三列一次给齐,漏一列就是 NOT NULL 违约。 */
  certificateColumns: {
    standardId: string;
    recognitionPolicyId: string;
    sourceCode: 'ADMIN';
  };
}

let seq = 0;

/**
 * 建一个 ACTIVE CREDENTIAL Standard + 一条 ACTIVE 最宽松 Policy。
 *
 * `code` 默认带自增后缀 —— 同一个 spec 里多次调用不会撞 `CertificateStandard_code_key`。
 * `categoryCode` 是 cert_type 字典 code:直插 Standard 不校验字典,
 * 但按类别过滤的读侧(资质判定 / App 列表)会用它,所以调用方按需传真值。
 */
export async function seedCertificateStandard(
  prisma: PrismaService,
  opts: { code?: string; categoryCode?: string; levelCode?: string; isInternal?: boolean } = {},
): Promise<SeededCertificateStandard> {
  seq += 1;
  const std = await prisma.certificateStandard.create({
    data: {
      code: opts.code ?? `fixture-std-${seq}`,
      name: opts.code ?? `夹具标准 ${seq}`,
      kind: 'CREDENTIAL',
      status: 'ACTIVE',
      categoryCode: opts.categoryCode ?? 'first_aid',
      ...(opts.levelCode !== undefined ? { levelCode: opts.levelCode } : {}),
      ...(opts.isInternal !== undefined ? { isInternal: opts.isInternal } : {}),
    },
    select: { id: true },
  });
  const policy = await prisma.certificateRecognitionPolicy.create({
    data: {
      standardId: std.id,
      version: 1,
      status: 'ACTIVE',
      issuerPolicy: 'FREE_TEXT',
      validityMode: 'EXPLICIT_OPTIONAL',
      certNumberMode: 'OPTIONAL',
    },
    select: { id: true },
  });
  return {
    standardId: std.id,
    policyId: policy.id,
    certificateColumns: {
      standardId: std.id,
      recognitionPolicyId: policy.id,
      // ADMIN 来源要求 sourceClaimId 为空(migration 里的
      // certificate_source_claim_consistency_check);直插夹具不带 claim,正好合规。
      sourceCode: 'ADMIN',
    },
  };
}
