import request from 'supertest';

import { devStubOcrImage, VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { issuePhoneVerificationToken } from './journey-recruitment-identity';
import { type JourneyRuntime, journeyPrisma } from './journey-runtime';

const RECRUITMENT_CYCLES = '/api/admin/v1/recruitment/cycles';
const OPEN_RECRUITMENT_APPLICATIONS = '/api/open/v1/recruitment/applications';
const OPEN_CERTIFICATE_CLAIMS = '/api/open/v1/recruitment/certificate-claims';
const ADMIN_RECRUITMENT = '/api/admin/v1/recruitment';
const CERTIFICATE_STANDARDS = '/api/admin/v1/certificate-standards';
const CERTIFICATE_POLICIES = '/api/admin/v1/certificate-recognition-policies';
const ID_CARD = '110101199003070046';

interface JourneyHttpResponse {
  status: number;
  body: { code?: number; message?: string; data?: unknown };
}

function requireStatus(response: JourneyHttpResponse, expected: number, action: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${action} expected HTTP ${expected}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}

async function createOpenRecruitmentCycle(runtime: JourneyRuntime): Promise<string> {
  const created = await request(httpServer(runtime.app))
    .post(RECRUITMENT_CYCLES)
    .set('Authorization', runtime.adminAuth)
    .send({ year: 2026, name: '旅程四招新轮次', capacity: 10 });
  requireStatus(created, 201, '创建旅程四招新轮次');
  const cycleId = String(created.body.data?.id ?? '');
  if (!cycleId) throw new Error('创建旅程四招新轮次未返回 id');
  const opened = await request(httpServer(runtime.app))
    .patch(`${RECRUITMENT_CYCLES}/${cycleId}`)
    .set('Authorization', runtime.adminAuth)
    .send({ statusCode: 'open' });
  requireStatus(opened, 200, '开启旅程四招新轮次');
  return cycleId;
}

async function submitApplicant(
  runtime: JourneyRuntime,
  cycleId: string,
): Promise<{
  applicationId: string;
  wechatCode: string;
}> {
  const prisma = journeyPrisma(runtime);
  const wechatCode = 'journey-4-applicant';
  const phone = '13900004001';
  // 招新链第一步走**真入口**:发码 → 验码 → 拿一次性 token(P2-12a;此前是直写会话行起步)
  const token = await issuePhoneVerificationToken(runtime, phone);
  const payload = {
    wechatCode,
    phoneVerificationToken: token,
    realName: '证书旅程申请人',
    idCardNumber: ID_CARD,
    documentTypeCode: 'mainland_id',
    phone,
    detailedAddress: '北京市朝阳区证书旅程测试街道 4 号',
    cityDistrict: '北京市朝阳区',
    sourceChannel: 'journey-test',
    emergencyContacts: [
      { name: '证书家属甲', relation: 'parent', phone: '13900004002' },
      { name: '证书家属乙', relation: 'family', phone: '13900004003' },
    ],
    privacyConsentAccepted: true,
  };
  const submitted = await request(httpServer(runtime.app))
    .post(OPEN_RECRUITMENT_APPLICATIONS)
    .field('payload', JSON.stringify(payload))
    .attach(
      'idCardImage',
      devStubOcrImage({ name: payload.realName, idCardNumber: ID_CARD, clarity: true }),
      { filename: 'journey-4-id.jpg', contentType: 'image/jpeg' },
    )
    .attach('signatureImage', VALID_PNG_IMAGE, {
      filename: 'journey-4-signature.png',
      contentType: 'image/png',
    });
  requireStatus(submitted, 201, '公开提交旅程四招新报名');
  if (submitted.body.data?.statusCode !== 'verified') {
    throw new Error(`旅程四报名未进入 verified: ${JSON.stringify(submitted.body)}`);
  }
  const application = await prisma.recruitmentApplication.findFirst({
    where: { cycleId, openid: `dev-openid-${wechatCode}` },
    select: { id: true },
  });
  if (!application) throw new Error('旅程四报名成功后未找到申请记录');
  return { applicationId: application.id, wechatCode };
}

async function createAndActivateRecognition(
  runtime: JourneyRuntime,
  categoryCode: 'first_aid' | 'bsafe',
): Promise<{ standardId: string; policyId: string }> {
  const created = await request(httpServer(runtime.app))
    .post(CERTIFICATE_STANDARDS)
    .set('Authorization', runtime.adminAuth)
    .send({
      code: `journey-4-${categoryCode}`,
      name: `旅程四 ${categoryCode} 证书标准`,
      kind: 'CREDENTIAL',
      categoryCode,
    });
  requireStatus(created, 201, `创建 ${categoryCode} 证书标准`);
  const standardId = String(created.body.data?.id ?? '');
  if (!standardId) throw new Error(`${categoryCode} 证书标准未返回 id`);

  const activatedStandard = await request(httpServer(runtime.app))
    .patch(`${CERTIFICATE_STANDARDS}/${standardId}/status`)
    .set('Authorization', runtime.adminAuth)
    .send({ status: 'ACTIVE' });
  requireStatus(activatedStandard, 200, `激活 ${categoryCode} 证书标准`);

  const createdPolicy = await request(httpServer(runtime.app))
    .post(`${CERTIFICATE_STANDARDS}/${standardId}/recognition-policies`)
    .set('Authorization', runtime.adminAuth)
    .send({
      issuerPolicy: 'FREE_TEXT',
      validityMode: 'EXPLICIT_OPTIONAL',
      certNumberMode: 'REQUIRED',
      issuers: [],
    });
  requireStatus(createdPolicy, 201, `创建 ${categoryCode} 认定规则`);
  const policyId = String(createdPolicy.body.data?.id ?? '');
  if (!policyId) throw new Error(`${categoryCode} 认定规则未返回 id`);

  const activatedPolicy = await request(httpServer(runtime.app))
    .patch(`${CERTIFICATE_POLICIES}/${policyId}/status`)
    .set('Authorization', runtime.adminAuth)
    .send({ status: 'ACTIVE' });
  requireStatus(activatedPolicy, 200, `激活 ${categoryCode} 认定规则`);
  return { standardId, policyId };
}

async function submitAndApproveClaim(
  runtime: JourneyRuntime,
  input: {
    categoryCode: 'first_aid' | 'bsafe';
    standardId: string;
    wechatCode: string;
    certNumber: string;
  },
): Promise<{ claimId: string; reviewedVersion: number }> {
  const submitted = await request(httpServer(runtime.app))
    .post(OPEN_CERTIFICATE_CLAIMS)
    .field('categoryHintCode', input.categoryCode)
    .field('suggestedStandardId', input.standardId)
    .field('rawCertificateName', `旅程四 ${input.categoryCode} 申报`)
    .field('issuingOrg', '旅程四测试发证机构')
    .field('certNumber', input.certNumber)
    .field('issuedAt', '2026-01-01')
    .field('wechatCode', input.wechatCode)
    .attach('images', VALID_PNG_IMAGE, {
      filename: `journey-4-${input.categoryCode}.png`,
      contentType: 'image/png',
    });
  requireStatus(submitted, 201, `公开提交 ${input.categoryCode} 证书申报`);
  const claim = submitted.body.data?.claim as { id?: string; version?: number } | undefined;
  if (!claim?.id || claim.version === undefined) {
    throw new Error(`公开提交 ${input.categoryCode} 证书申报未返回 claim`);
  }
  const reviewed = await request(httpServer(runtime.app))
    .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
    .set('Authorization', runtime.adminAuth)
    .send({
      decision: 'APPROVE',
      version: claim.version,
      standardId: input.standardId,
      issuingOrg: '旅程四测试发证机构',
      certNumber: input.certNumber,
      issuedAt: '2026-01-01',
    });
  requireStatus(reviewed, 200, `审核通过 ${input.categoryCode} 证书申报`);
  const reviewedVersion = Number(reviewed.body.data?.version);
  if (!Number.isInteger(reviewedVersion)) {
    throw new Error(`${input.categoryCode} 证书审核未返回新版本`);
  }
  return { claimId: claim.id, reviewedVersion };
}

export interface CertificateRecognitionJourneyResult {
  readonly claimId: string;
  readonly certificateStandardId: string;
  readonly certificatePolicyId: string;
  readonly certificateStatus: string;
  readonly certificateNumber: string | null;
  replayClaimReview(): Promise<number>;
}

/** 金五条④：标准→认定规则→招新申报→审核→发号建正式证书。 */
export async function runCertificateRecognitionJourney(
  runtime: JourneyRuntime,
): Promise<CertificateRecognitionJourneyResult> {
  const prisma = journeyPrisma(runtime);
  const cycleId = await createOpenRecruitmentCycle(runtime);
  const { applicationId, wechatCode } = await submitApplicant(runtime, cycleId);
  const firstAid = await createAndActivateRecognition(runtime, 'first_aid');
  const bsafe = await createAndActivateRecognition(runtime, 'bsafe');
  const firstAidClaim = await submitAndApproveClaim(runtime, {
    categoryCode: 'first_aid',
    standardId: firstAid.standardId,
    wechatCode,
    certNumber: 'J4-FA-001',
  });
  await submitAndApproveClaim(runtime, {
    categoryCode: 'bsafe',
    standardId: bsafe.standardId,
    wechatCode,
    certNumber: 'J4-BS-001',
  });

  for (const thresholdCode of ['patrol1', 'patrol2', 'training']) {
    const marked = await request(httpServer(runtime.app))
      .patch(`${ADMIN_RECRUITMENT}/applications/${applicationId}/thresholds`)
      .set('Authorization', runtime.adminAuth)
      .send({ thresholdCode, completed: true });
    requireStatus(marked, 200, `标记旅程四招新门槛 ${thresholdCode}`);
  }
  const evaluated = await request(httpServer(runtime.app))
    .post(`${ADMIN_RECRUITMENT}/applications/${applicationId}/evaluate`)
    .set('Authorization', runtime.adminAuth)
    .send({ approved: true, note: '旅程四综合评定通过' });
  requireStatus(evaluated, 200, '旅程四招新综合评定');
  if (evaluated.body.data?.statusCode !== 'publicity') {
    throw new Error(`旅程四综合评定未进入 publicity: ${JSON.stringify(evaluated.body)}`);
  }

  // journey-direct-write: ambient — 组织树底座
  await prisma.organization.create({
    data: { name: '旅程四志愿者归口', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
  });
  const promoted = await request(httpServer(runtime.app))
    .post(`${RECRUITMENT_CYCLES}/${cycleId}/promote`)
    .set('Authorization', runtime.adminAuth)
    .send({});
  requireStatus(promoted, 200, '旅程四批量发号');

  const certificate = await prisma.certificate.findFirst({
    where: { sourceClaimId: firstAidClaim.claimId, deletedAt: null },
    select: {
      certStatusCode: true,
      certNumber: true,
      standardId: true,
      recognitionPolicyId: true,
    },
  });
  if (!certificate) throw new Error('发号后未从已审核申报建立正式证书');

  return {
    claimId: firstAidClaim.claimId,
    certificateStandardId: certificate.standardId,
    certificatePolicyId: certificate.recognitionPolicyId,
    certificateStatus: certificate.certStatusCode,
    certificateNumber: certificate.certNumber,
    async replayClaimReview(): Promise<number> {
      const replay = await request(httpServer(runtime.app))
        .post(`${ADMIN_RECRUITMENT}/certificate-claims/${firstAidClaim.claimId}/review`)
        .set('Authorization', runtime.adminAuth)
        .send({
          decision: 'APPROVE',
          version: firstAidClaim.reviewedVersion,
          standardId: firstAid.standardId,
          issuingOrg: '旅程四测试发证机构',
          certNumber: 'J4-FA-001',
          issuedAt: '2026-01-01',
        });
      return Number(replay.body.code ?? 0);
    },
  };
}
