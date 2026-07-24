import {
  BindingScopeType,
  BindingStatus,
  DictItemStatus,
  DictTypeStatus,
  MemberStatus,
  MembershipStatus,
  MembershipType,
  OrganizationStatus,
  Prisma,
  PrismaClient,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_DATABASE_PATTERN = /^app_local_frontend(?:_[a-z0-9][a-z0-9_]*)?$/;
const FIXTURE_LOCK_KEY = 'srvf:local-activity-frontend-fixture:v1';
const FIXTURE_NOTE = 'LOCAL-FE fixture';
const ROOT_ORGANIZATION_CODE = 'SRVF';
const LEGACY_ACTIVITY_ROLE_CODE = 'test-legacy-activity-actions';
const SYSTEM_MANAGED_ROLE_CODES = [
  'activity-owner',
  'activity-registration-collaborator',
  'activity-attendance-collaborator',
] as const;

const ROLE_PERMISSION_CONTRACT = {
  'activity-publish-reviewer': [
    'activity-review.read.request',
    'activity.publish.record',
    'activity-review.return.request',
  ],
  'attendance-first-reviewer': [
    'attendance.read.sheet',
    'attendance.approve.sheet',
    'attendance.reject.sheet',
    'attendance.return.sheet',
  ],
  'attendance-final-reviewer': [
    'attendance.read.sheet',
    'attendance.final-approve.sheet',
    'attendance.final-reject.sheet',
    'attendance.reopen.sheet',
    'attendance.final-return.sheet',
  ],
  'activity-cross-org-initiator': ['activity.create.cross-org'],
} as const;

const BIZ_ADMIN_FORBIDDEN_ACTIVITY_CODES = [
  'activity-review.return.request',
  'activity-responsibility.override.record',
  'activity.publish.record',
  'activity.update.record',
  'activity.cancel.record',
  'activity.complete.record',
  'activity-registration.create.record',
  'activity-registration.approve.record',
  'activity-registration.reject.record',
  'activity-registration.cancel.record',
  'activity-registration.reopen.record',
  'attendance.create.sheet',
  'attendance.update.sheet',
  'attendance.delete.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.return.sheet',
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
  'attendance.final-return.sheet',
] as const;

export const LOCAL_ACTIVITY_FRONTEND_ORGANIZATIONS = [
  {
    key: 'A',
    code: 'LOCAL-FE-A',
    name: 'Local Organization A',
    nodeTypeCode: 'group',
    sortOrder: 901,
  },
  {
    key: 'B',
    code: 'LOCAL-FE-B',
    name: 'Local Organization B',
    nodeTypeCode: 'group',
    sortOrder: 902,
  },
] as const;

type FixtureOrganizationKey = (typeof LOCAL_ACTIVITY_FRONTEND_ORGANIZATIONS)[number]['key'];

interface FixtureAccount {
  username: string;
  memberNo: string;
  displayName: string;
  duty: string;
  organization: FixtureOrganizationKey;
  gradeCode: string | null;
  role: Role;
  page: string;
}

export const LOCAL_ACTIVITY_FRONTEND_ACCOUNTS: readonly FixtureAccount[] = [
  {
    username: 'local_fe_owner',
    memberNo: 'LOCAL-FE-OWNER',
    displayName: 'LOCAL-FE Owner',
    duty: '活动发起人 / 初始负责人',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：活动创建、我管理的活动',
  },
  {
    username: 'local_fe_publish_reviewer',
    memberNo: 'LOCAL-FE-PUBLISH-REVIEWER',
    displayName: 'LOCAL-FE Publish Reviewer',
    duty: '组织 A 发布审核员',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '管理端：活动发布审核',
  },
  {
    username: 'local_fe_registration_collab',
    memberNo: 'LOCAL-FE-REGISTRATION-COLLAB',
    displayName: 'LOCAL-FE Registration Collaborator',
    duty: '报名协办候选人（初始无活动责任）',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：我管理的活动、报名管理',
  },
  {
    username: 'local_fe_attendance_collab',
    memberNo: 'LOCAL-FE-ATTENDANCE-COLLAB',
    displayName: 'LOCAL-FE Attendance Collaborator',
    duty: '考勤协办候选人（初始无活动责任）',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：我管理的活动、考勤管理',
  },
  {
    username: 'local_fe_first_a',
    memberNo: 'LOCAL-FE-FIRST-A',
    displayName: 'LOCAL-FE First Reviewer A',
    duty: '组织 A 考勤一审员 A',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '管理端：考勤一审',
  },
  {
    username: 'local_fe_first_b',
    memberNo: 'LOCAL-FE-FIRST-B',
    displayName: 'LOCAL-FE First Reviewer B',
    duty: '组织 A 考勤一审员 B',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '管理端：考勤一审',
  },
  {
    username: 'local_fe_final_a',
    memberNo: 'LOCAL-FE-FINAL-A',
    displayName: 'LOCAL-FE Final Reviewer A',
    duty: '组织 A 考勤终审员 A',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '管理端：考勤终审',
  },
  {
    username: 'local_fe_final_b',
    memberNo: 'LOCAL-FE-FINAL-B',
    displayName: 'LOCAL-FE Final Reviewer B',
    duty: '组织 A 考勤终审员 B',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '管理端：考勤终审',
  },
  {
    username: 'local_fe_new_owner',
    memberNo: 'LOCAL-FE-NEW-OWNER',
    displayName: 'LOCAL-FE New Owner',
    duty: '负责人移交接收人',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：我管理的活动',
  },
  {
    username: 'local_fe_participant_a',
    memberNo: 'LOCAL-FE-PARTICIPANT-A',
    displayName: 'LOCAL-FE Participant A',
    duty: '报名与考勤参与者 A',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：活动报名、签到签退',
  },
  {
    username: 'local_fe_participant_b',
    memberNo: 'LOCAL-FE-PARTICIPANT-B',
    displayName: 'LOCAL-FE Participant B',
    duty: '报名与考勤参与者 B',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：活动报名、签到签退',
  },
  {
    username: 'local_fe_unrelated_admin',
    memberNo: 'LOCAL-FE-UNRELATED-ADMIN',
    displayName: 'LOCAL-FE Unrelated Admin',
    duty: '普通业务管理员（活动责任负向验证）',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.ADMIN,
    page: '管理端：普通业务管理；活动责任页应无写权限',
  },
  {
    username: 'local_fe_cross_org',
    memberNo: 'LOCAL-FE-CROSS-ORG',
    displayName: 'LOCAL-FE Cross Organization Initiator',
    duty: '组织 B 精确跨组织发起人',
    organization: 'A',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：活动创建（可选组织 B）',
  },
  {
    username: 'local_fe_org_b_owner',
    memberNo: 'LOCAL-FE-ORG-B-OWNER',
    displayName: 'LOCAL-FE Organization B Owner',
    duty: '组织 B 发起人兼发布审核员',
    organization: 'B',
    gradeCode: 'level-3',
    role: Role.USER,
    page: '小程序：组织 B 活动；管理端：组织 B 发布审核',
  },
  {
    username: 'local_fe_volunteer',
    memberNo: 'LOCAL-FE-VOLUNTEER',
    displayName: 'LOCAL-FE Volunteer',
    duty: '志愿者等级负向账号',
    organization: 'A',
    gradeCode: 'volunteer',
    role: Role.USER,
    page: '小程序：不应显示活动发起入口',
  },
  {
    username: 'local_fe_reserve',
    memberNo: 'LOCAL-FE-RESERVE',
    displayName: 'LOCAL-FE Reserve',
    duty: '预备队员等级负向账号',
    organization: 'A',
    gradeCode: 'reserve',
    role: Role.USER,
    page: '小程序：不应显示活动发起入口',
  },
  {
    username: 'local_fe_no_grade',
    memberNo: 'LOCAL-FE-NO-GRADE',
    displayName: 'LOCAL-FE No Grade',
    duty: '无等级负向账号',
    organization: 'A',
    gradeCode: null,
    role: Role.USER,
    page: '小程序：不应显示活动发起入口',
  },
] as const;

type LocalFixtureCommand = 'setup' | 'verify' | 'print' | 'cleanup';
type FixtureEnvironment = NodeJS.ProcessEnv;
type FixtureDatabaseClient = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'organization'
  | 'organizationClosure'
  | 'member'
  | 'memberOrganizationMembership'
  | 'user'
  | 'rbacRole'
  | 'roleBinding'
  | 'activityResponsibilityAssignment'
  | 'activity'
  | 'activityPublishReview'
  | 'activityRegistration'
  | 'activityCheckIn'
  | 'attendanceSheet'
  | 'attendanceRecord'
  | 'activityFeedback'
  | 'dictType'
>;

interface LocalFixtureTarget {
  appEnv: 'development' | 'test';
  database: string;
  databaseUrl: string;
}

interface FixtureDependencies {
  createPrisma: (databaseUrl: string) => PrismaClient;
  fetch: typeof fetch;
}

interface ExpectedBinding {
  username: string;
  principalType: PrincipalType;
  roleCode: string;
  scopeType: BindingScopeType;
  scopeOrganization: FixtureOrganizationKey | null;
}

const EXPECTED_BINDINGS: readonly ExpectedBinding[] = [
  {
    username: 'local_fe_publish_reviewer',
    principalType: PrincipalType.USER,
    roleCode: 'activity-publish-reviewer',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'A',
  },
  {
    username: 'local_fe_first_a',
    principalType: PrincipalType.USER,
    roleCode: 'attendance-first-reviewer',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'A',
  },
  {
    username: 'local_fe_first_b',
    principalType: PrincipalType.USER,
    roleCode: 'attendance-first-reviewer',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'A',
  },
  {
    username: 'local_fe_final_a',
    principalType: PrincipalType.USER,
    roleCode: 'attendance-final-reviewer',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'A',
  },
  {
    username: 'local_fe_final_b',
    principalType: PrincipalType.USER,
    roleCode: 'attendance-final-reviewer',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'A',
  },
  {
    username: 'local_fe_cross_org',
    principalType: PrincipalType.MEMBER,
    roleCode: 'activity-cross-org-initiator',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'B',
  },
  {
    username: 'local_fe_org_b_owner',
    principalType: PrincipalType.USER,
    roleCode: 'activity-publish-reviewer',
    scopeType: BindingScopeType.ORGANIZATION,
    scopeOrganization: 'B',
  },
  {
    username: 'local_fe_unrelated_admin',
    principalType: PrincipalType.USER,
    roleCode: 'biz-admin',
    scopeType: BindingScopeType.GLOBAL,
    scopeOrganization: null,
  },
] as const;

export class LocalActivityFrontendFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalActivityFrontendFixtureError';
  }
}

export function assertLocalActivityFrontendTarget(
  environment: FixtureEnvironment,
): LocalFixtureTarget {
  const appEnv = environment.APP_ENV;
  if (appEnv !== 'development' && appEnv !== 'test') {
    throw new LocalActivityFrontendFixtureError(
      'APP_ENV 只允许 development 或 test；production、smoke、空值和其他环境均被拒绝',
    );
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new LocalActivityFrontendFixtureError('DATABASE_URL 未设置');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new LocalActivityFrontendFixtureError('DATABASE_URL 不是合法 PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new LocalActivityFrontendFixtureError(
      'DATABASE_URL 必须使用 postgresql:// 或 postgres://',
    );
  }
  const rawDatabase = parsed.pathname.slice(1);
  let database: string;
  try {
    database = decodeURIComponent(rawDatabase);
  } catch {
    throw new LocalActivityFrontendFixtureError('DATABASE_URL 数据库名编码无效');
  }
  if (!database || database.includes('/')) {
    throw new LocalActivityFrontendFixtureError('DATABASE_URL 必须明确且只包含一个数据库名');
  }
  if (database.length > 63 || !LOCAL_DATABASE_PATTERN.test(database)) {
    throw new LocalActivityFrontendFixtureError(
      '目标数据库名只允许 app_local_frontend 或 app_local_frontend_<小写字母数字下划线后缀>',
    );
  }
  const schemas = parsed.searchParams.getAll('schema');
  if (schemas.length > 1 || (schemas[0] && schemas[0] !== 'public')) {
    throw new LocalActivityFrontendFixtureError('本地 fixture 只允许 PostgreSQL public schema');
  }

  const confirmation = environment.LOCAL_FIXTURE_CONFIRM_DATABASE;
  if (!confirmation) {
    throw new LocalActivityFrontendFixtureError('LOCAL_FIXTURE_CONFIRM_DATABASE 未设置');
  }
  if (confirmation !== confirmation.trim()) {
    throw new LocalActivityFrontendFixtureError(
      'LOCAL_FIXTURE_CONFIRM_DATABASE 不得含首尾空白，必须逐字确认数据库名',
    );
  }
  if (confirmation !== database) {
    throw new LocalActivityFrontendFixtureError(
      'LOCAL_FIXTURE_CONFIRM_DATABASE 与 DATABASE_URL 中解析出的数据库名不完全一致',
    );
  }

  return { appEnv, database, databaseUrl };
}

export function assertLocalActivityFrontendPassword(environment: FixtureEnvironment): string {
  const password = environment.LOCAL_FRONTEND_FIXTURE_PASSWORD;
  if (!password) {
    throw new LocalActivityFrontendFixtureError('LOCAL_FRONTEND_FIXTURE_PASSWORD 未设置');
  }
  if (
    password.length < 8 ||
    password.length > 128 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new LocalActivityFrontendFixtureError(
      'LOCAL_FRONTEND_FIXTURE_PASSWORD 必须为 8–128 位且同时包含字母和数字',
    );
  }
  return password;
}

export function parseLocalActivityFrontendCommand(
  command: string | undefined,
): LocalFixtureCommand {
  if (command === 'setup' || command === 'verify' || command === 'print' || command === 'cleanup') {
    return command;
  }
  throw new LocalActivityFrontendFixtureError('命令必须是 setup、verify、print 或 cleanup 之一');
}

export async function runLocalActivityFrontendFixture(
  commandValue: string | undefined,
  environment: FixtureEnvironment,
  dependencyOverrides: Partial<FixtureDependencies> = {},
): Promise<string> {
  const command = parseLocalActivityFrontendCommand(commandValue);
  const target = assertLocalActivityFrontendTarget(environment);

  if (command === 'print') return renderFixtureAccountManifest();
  if (command === 'cleanup') return renderGuardedCleanupInstructions(target.database);

  const password =
    command === 'setup' || environment.LOCAL_API_BASE_URL
      ? assertLocalActivityFrontendPassword(environment)
      : null;
  const dependencies: FixtureDependencies = {
    createPrisma: (databaseUrl) =>
      new PrismaClient({ datasourceUrl: databaseUrl, errorFormat: 'minimal' }),
    fetch: globalThis.fetch,
    ...dependencyOverrides,
  };
  const prisma = dependencies.createPrisma(target.databaseUrl);

  try {
    await prisma.$connect();
    await assertLatestMigrationApplied(prisma);

    if (command === 'setup') {
      const result = await setupLocalActivityFrontendFixture(prisma, password!);
      return [
        'local activity fixture setup complete',
        `database=${target.database}`,
        `organizations=${result.organizations}`,
        `accounts=${result.accounts}`,
        `memberships=${result.memberships}`,
        `roleBindings=${result.roleBindings}`,
        'businessRecords=0',
      ].join(' ');
    }

    const result = await verifyLocalActivityFrontendFixture(prisma);
    const apiBaseUrl = environment.LOCAL_API_BASE_URL?.trim();
    const http = apiBaseUrl
      ? await verifyLocalActivityFrontendHttp(
          apiBaseUrl,
          password!,
          dependencies.fetch,
          result.organizationIds,
        )
      : 'skipped';
    return [
      'local activity fixture verify passed',
      `database=${target.database}`,
      `accounts=${result.accounts}`,
      `memberships=${result.memberships}`,
      `roleBindings=${result.roleBindings}`,
      `http=${http}`,
    ].join(' ');
  } catch (error) {
    if (error instanceof LocalActivityFrontendFixtureError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new LocalActivityFrontendFixtureError(
        `数据库操作失败（Prisma ${error.code}）；事务已回滚，未输出连接信息`,
      );
    }
    throw new LocalActivityFrontendFixtureError(
      '数据库或 HTTP 验证失败；未输出连接信息、密码或 token',
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function assertLatestMigrationApplied(
  prisma: Pick<PrismaClient, '$queryRaw'>,
): Promise<void> {
  let latestMigration: string;
  try {
    latestMigration = readdirSync(resolve(process.cwd(), 'prisma/migrations'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && /^\d+/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1)!;
  } catch {
    throw new LocalActivityFrontendFixtureError('无法读取 prisma/migrations，拒绝继续');
  }
  if (!latestMigration) {
    throw new LocalActivityFrontendFixtureError('未找到 migration，拒绝继续');
  }

  const rows = await prisma.$queryRaw<Array<{ applied: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS applied
    FROM "_prisma_migrations"
    WHERE "migration_name" = ${latestMigration}
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  `);
  if (rows[0]?.applied !== 1) {
    throw new LocalActivityFrontendFixtureError(
      `最新 migration '${latestMigration}' 尚未成功应用；请先执行 pnpm prisma:deploy`,
    );
  }
}

export async function setupLocalActivityFrontendFixture(
  prisma: PrismaClient,
  password: string,
): Promise<{
  organizations: number;
  accounts: number;
  memberships: number;
  roleBindings: number;
}> {
  const passwordHash = await bcrypt.hash(password, 10);

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${FIXTURE_LOCK_KEY}))
      `);

      const roles = await loadAndValidateSeedRoles(tx);
      await validateSeedDictionaries(tx);
      const organizations = await ensureFixtureOrganizations(tx);
      const accounts = await ensureFixtureAccounts(tx, password, passwordHash);
      await ensureFixtureMemberships(tx, accounts.memberIdsByUsername, organizations);
      await ensureFixtureRoleBindings(
        tx,
        accounts.userIdsByUsername,
        accounts.memberIdsByUsername,
        organizations,
        roles,
      );

      const verified = await verifyFixtureDatabaseState(tx);
      return {
        organizations: 2,
        accounts: verified.accounts,
        memberships: verified.memberships,
        roleBindings: verified.roleBindings,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
}

async function loadAndValidateSeedRoles(db: FixtureDatabaseClient): Promise<Map<string, string>> {
  const requiredCodes = [
    ...Object.keys(ROLE_PERMISSION_CONTRACT),
    'biz-admin',
    ...SYSTEM_MANAGED_ROLE_CODES,
  ];
  const roles = await db.rbacRole.findMany({
    where: { code: { in: requiredCodes } },
    select: {
      id: true,
      code: true,
      deletedAt: true,
      rolePermissions: {
        select: { permission: { select: { code: true } } },
      },
    },
  });
  const byCode = new Map(roles.map((role) => [role.code, role]));

  for (const code of requiredCodes) {
    const role = byCode.get(code);
    if (!role || role.deletedAt) {
      throw new LocalActivityFrontendFixtureError(
        `seed 异常：缺少 active 系统角色 '${code}'；fixture 不会自行创建角色`,
      );
    }
  }

  for (const [code, expected] of Object.entries(ROLE_PERMISSION_CONTRACT)) {
    const actual = byCode
      .get(code)!
      .rolePermissions.map((item) => item.permission.code)
      .sort();
    assertEqualStringSets(
      actual,
      [...expected].sort(),
      `seed 角色 '${code}' 的权限集合与冻结契约不一致`,
    );
  }

  const bizAdminPermissions = new Set(
    byCode.get('biz-admin')!.rolePermissions.map((item) => item.permission.code),
  );
  const forbiddenBizAdminCodes = BIZ_ADMIN_FORBIDDEN_ACTIVITY_CODES.filter((code) =>
    bizAdminPermissions.has(code),
  );
  if (forbiddenBizAdminCodes.length > 0) {
    throw new LocalActivityFrontendFixtureError(
      `seed 角色 'biz-admin' 错误持有活动责任写权限：${forbiddenBizAdminCodes.join(', ')}`,
    );
  }

  return new Map(roles.map((role) => [role.code, role.id]));
}

async function validateSeedDictionaries(db: FixtureDatabaseClient): Promise<void> {
  const required = new Map([
    ['node_type', ['group']],
    ['member_grade', ['level-3', 'volunteer', 'reserve']],
  ]);
  const types = await db.dictType.findMany({
    where: { code: { in: [...required.keys()] } },
    select: {
      code: true,
      status: true,
      deletedAt: true,
      items: {
        where: { deletedAt: null },
        select: { code: true, status: true },
      },
    },
  });
  const typesByCode = new Map(types.map((type) => [type.code, type]));
  for (const [typeCode, itemCodes] of required) {
    const type = typesByCode.get(typeCode);
    if (!type || type.status !== DictTypeStatus.ACTIVE || type.deletedAt !== null) {
      throw new LocalActivityFrontendFixtureError(
        `seed 异常：缺少 active 字典类型 '${typeCode}'；fixture 不会自行创建字典`,
      );
    }
    const activeCodes = new Set(
      type.items.filter((item) => item.status === DictItemStatus.ACTIVE).map((item) => item.code),
    );
    const missing = itemCodes.filter((code) => !activeCodes.has(code));
    if (missing.length > 0) {
      throw new LocalActivityFrontendFixtureError(
        `seed 异常：字典 '${typeCode}' 缺少 active item：${missing.join(', ')}`,
      );
    }
  }
}

async function ensureFixtureOrganizations(
  tx: Prisma.TransactionClient,
): Promise<Record<FixtureOrganizationKey, string>> {
  const root = await tx.organization.findUnique({
    where: { code: ROOT_ORGANIZATION_CODE },
    select: {
      id: true,
      parentId: true,
      status: true,
      deletedAt: true,
    },
  });
  if (
    !root ||
    root.parentId !== null ||
    root.status !== OrganizationStatus.ACTIVE ||
    root.deletedAt !== null
  ) {
    throw new LocalActivityFrontendFixtureError(
      "seed 异常：需要 active、未删除且 parentId=null 的 'SRVF' 根组织",
    );
  }
  const rootSelfClosure = await tx.organizationClosure.findUnique({
    where: {
      ancestorId_descendantId: {
        ancestorId: root.id,
        descendantId: root.id,
      },
    },
    select: { depth: true },
  });
  if (rootSelfClosure?.depth !== 0) {
    throw new LocalActivityFrontendFixtureError('seed 异常：SRVF 根组织 closure 自身行缺失');
  }

  const ids = {} as Record<FixtureOrganizationKey, string>;
  for (const expected of LOCAL_ACTIVITY_FRONTEND_ORGANIZATIONS) {
    let organization = await tx.organization.findUnique({
      where: { code: expected.code },
      select: {
        id: true,
        name: true,
        code: true,
        parentId: true,
        nodeTypeCode: true,
        establishmentStatusCode: true,
        groupFunctionCode: true,
        sortOrder: true,
        status: true,
        deletedAt: true,
      },
    });
    if (!organization) {
      organization = await tx.organization.create({
        data: {
          name: expected.name,
          code: expected.code,
          parentId: root.id,
          nodeTypeCode: expected.nodeTypeCode,
          sortOrder: expected.sortOrder,
          status: OrganizationStatus.ACTIVE,
        },
        select: {
          id: true,
          name: true,
          code: true,
          parentId: true,
          nodeTypeCode: true,
          establishmentStatusCode: true,
          groupFunctionCode: true,
          sortOrder: true,
          status: true,
          deletedAt: true,
        },
      });
    }
    if (
      organization.name !== expected.name ||
      organization.code !== expected.code ||
      organization.parentId !== root.id ||
      organization.nodeTypeCode !== expected.nodeTypeCode ||
      organization.establishmentStatusCode !== null ||
      organization.groupFunctionCode !== null ||
      organization.sortOrder !== expected.sortOrder ||
      organization.status !== OrganizationStatus.ACTIVE ||
      organization.deletedAt !== null
    ) {
      throw new LocalActivityFrontendFixtureError(
        `fixture 组织 '${expected.code}' 已存在但形状不一致；请重建专用本地数据库`,
      );
    }

    await tx.organizationClosure.upsert({
      where: {
        ancestorId_descendantId: {
          ancestorId: organization.id,
          descendantId: organization.id,
        },
      },
      update: {},
      create: {
        ancestorId: organization.id,
        descendantId: organization.id,
        depth: 0,
      },
    });
    await tx.organizationClosure.upsert({
      where: {
        ancestorId_descendantId: {
          ancestorId: root.id,
          descendantId: organization.id,
        },
      },
      update: {},
      create: {
        ancestorId: root.id,
        descendantId: organization.id,
        depth: 1,
      },
    });

    const closures = await tx.organizationClosure.findMany({
      where: { descendantId: organization.id },
      select: { ancestorId: true, descendantId: true, depth: true },
    });
    const closureKeys = closures
      .map((row) => `${row.ancestorId}:${row.descendantId}:${row.depth}`)
      .sort();
    const expectedClosureKeys = [
      `${organization.id}:${organization.id}:0`,
      `${root.id}:${organization.id}:1`,
    ].sort();
    assertEqualStringSets(
      closureKeys,
      expectedClosureKeys,
      `fixture 组织 '${expected.code}' 的 closure 存在漂移`,
    );
    ids[expected.key] = organization.id;
  }
  return ids;
}

async function ensureFixtureAccounts(
  tx: Prisma.TransactionClient,
  password: string,
  passwordHash: string,
): Promise<{
  userIdsByUsername: Map<string, string>;
  memberIdsByUsername: Map<string, string>;
}> {
  const userIdsByUsername = new Map<string, string>();
  const memberIdsByUsername = new Map<string, string>();

  for (const expected of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    let member = await tx.member.findUnique({
      where: { memberNo: expected.memberNo },
      select: {
        id: true,
        memberNo: true,
        displayName: true,
        gradeCode: true,
        status: true,
        deletedAt: true,
      },
    });
    if (!member) {
      member = await tx.member.create({
        data: {
          memberNo: expected.memberNo,
          displayName: expected.displayName,
          gradeCode: expected.gradeCode,
          status: MemberStatus.ACTIVE,
        },
        select: {
          id: true,
          memberNo: true,
          displayName: true,
          gradeCode: true,
          status: true,
          deletedAt: true,
        },
      });
    }
    if (
      member.memberNo !== expected.memberNo ||
      member.displayName !== expected.displayName ||
      member.gradeCode !== expected.gradeCode ||
      member.status !== MemberStatus.ACTIVE ||
      member.deletedAt !== null
    ) {
      throw new LocalActivityFrontendFixtureError(
        `fixture Member '${expected.memberNo}' 已存在但形状不一致；请重建专用本地数据库`,
      );
    }

    let user = await tx.user.findUnique({
      where: { username: expected.username },
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        nickname: true,
        avatarKey: true,
        role: true,
        status: true,
        deletedAt: true,
        phone: true,
        phoneVerifiedAt: true,
        openid: true,
        memberId: true,
      },
    });
    if (!user) {
      const linkedUser = await tx.user.findFirst({
        where: { memberId: member.id, deletedAt: null },
        select: { username: true },
      });
      if (linkedUser) {
        throw new LocalActivityFrontendFixtureError(
          `fixture Member '${expected.memberNo}' 已关联其他 active User，拒绝覆盖`,
        );
      }
      user = await tx.user.create({
        data: {
          username: expected.username,
          passwordHash,
          nickname: expected.displayName,
          role: expected.role,
          status: UserStatus.ACTIVE,
          memberId: member.id,
        },
        select: {
          id: true,
          username: true,
          email: true,
          passwordHash: true,
          nickname: true,
          avatarKey: true,
          role: true,
          status: true,
          deletedAt: true,
          phone: true,
          phoneVerifiedAt: true,
          openid: true,
          memberId: true,
        },
      });
    }
    assertFixtureUserShape(user, expected, member.id);

    if (!(await bcrypt.compare(password, user.passwordHash))) {
      throw new LocalActivityFrontendFixtureError(
        `fixture User '${expected.username}' 的既有密码与本次输入不一致；拒绝绕过会话撤销与审计，请 guarded rebuild 专用本地数据库`,
      );
    }

    userIdsByUsername.set(expected.username, user.id);
    memberIdsByUsername.set(expected.username, member.id);
  }

  const activeLinkedUsers = await tx.user.count({
    where: {
      memberId: { in: [...memberIdsByUsername.values()] },
      deletedAt: null,
    },
  });
  if (activeLinkedUsers !== LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length) {
    throw new LocalActivityFrontendFixtureError(
      'fixture Member 存在重复 active User 关联；事务已回滚',
    );
  }

  return { userIdsByUsername, memberIdsByUsername };
}

function assertFixtureUserShape(
  user: {
    username: string;
    email: string | null;
    nickname: string | null;
    avatarKey: string | null;
    role: Role;
    status: UserStatus;
    deletedAt: Date | null;
    phone: string | null;
    phoneVerifiedAt: Date | null;
    openid: string | null;
    memberId: string | null;
  },
  expected: FixtureAccount,
  memberId: string,
): void {
  if (
    user.username !== expected.username ||
    user.email !== null ||
    user.nickname !== expected.displayName ||
    user.avatarKey !== null ||
    user.role !== expected.role ||
    user.status !== UserStatus.ACTIVE ||
    user.deletedAt !== null ||
    user.phone !== null ||
    user.phoneVerifiedAt !== null ||
    user.openid !== null ||
    user.memberId !== memberId
  ) {
    throw new LocalActivityFrontendFixtureError(
      `fixture User '${expected.username}' 已存在但形状不一致；请重建专用本地数据库`,
    );
  }
}

async function ensureFixtureMemberships(
  tx: Prisma.TransactionClient,
  memberIdsByUsername: Map<string, string>,
  organizationIds: Record<FixtureOrganizationKey, string>,
): Promise<void> {
  for (const expected of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    const memberId = requiredMapValue(memberIdsByUsername, expected.username, 'Member');
    const organizationId = organizationIds[expected.organization];
    let memberships = await tx.memberOrganizationMembership.findMany({
      where: {
        memberId,
        status: MembershipStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        id: true,
        organizationId: true,
        membershipType: true,
        startedAt: true,
        endedAt: true,
        reason: true,
        createdByUserId: true,
        endedByUserId: true,
      },
    });
    if (memberships.length === 0) {
      await tx.memberOrganizationMembership.create({
        data: {
          memberId,
          organizationId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
          reason: FIXTURE_NOTE,
        },
        select: { id: true },
      });
      memberships = await tx.memberOrganizationMembership.findMany({
        where: {
          memberId,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
        },
        select: {
          id: true,
          organizationId: true,
          membershipType: true,
          startedAt: true,
          endedAt: true,
          reason: true,
          createdByUserId: true,
          endedByUserId: true,
        },
      });
    }
    const membership = memberships[0];
    if (
      memberships.length !== 1 ||
      !membership ||
      membership.organizationId !== organizationId ||
      membership.membershipType !== MembershipType.PRIMARY ||
      membership.startedAt > new Date() ||
      membership.endedAt !== null ||
      membership.reason !== FIXTURE_NOTE ||
      membership.createdByUserId !== null ||
      membership.endedByUserId !== null
    ) {
      throw new LocalActivityFrontendFixtureError(
        `fixture Membership '${expected.username}' 存在漂移或重复；请重建专用本地数据库`,
      );
    }
  }
}

async function ensureFixtureRoleBindings(
  tx: Prisma.TransactionClient,
  userIdsByUsername: Map<string, string>,
  memberIdsByUsername: Map<string, string>,
  organizationIds: Record<FixtureOrganizationKey, string>,
  roleIdsByCode: Map<string, string>,
): Promise<void> {
  const allowedExistingKeys = new Set(
    EXPECTED_BINDINGS.map((binding) =>
      expectedBindingKey(
        binding,
        userIdsByUsername,
        memberIdsByUsername,
        organizationIds,
        roleIdsByCode,
      ),
    ),
  );
  const fixtureUserIds = [...userIdsByUsername.values()];
  const fixtureMemberIds = [...memberIdsByUsername.values()];
  const now = new Date();
  const existing = await tx.roleBinding.findMany({
    where: {
      status: BindingStatus.ACTIVE,
      deletedAt: null,
      OR: [
        { principalType: PrincipalType.USER, principalId: { in: fixtureUserIds } },
        { principalType: PrincipalType.MEMBER, principalId: { in: fixtureMemberIds } },
      ],
    },
    select: {
      principalType: true,
      principalId: true,
      roleId: true,
      scopeType: true,
      scopeOrgId: true,
      scopeActivityId: true,
      scopeResourceType: true,
      scopeResourceId: true,
      startedAt: true,
      endedAt: true,
      createdByUserId: true,
      note: true,
    },
  });
  for (const binding of existing) {
    const key = persistedBindingKey(binding);
    if (
      !allowedExistingKeys.has(key) ||
      binding.endedAt !== null ||
      binding.scopeActivityId !== null ||
      binding.scopeResourceType !== null ||
      binding.scopeResourceId !== null ||
      binding.startedAt > now ||
      binding.createdByUserId !== null ||
      binding.note !== FIXTURE_NOTE
    ) {
      throw new LocalActivityFrontendFixtureError(
        'fixture principal 已持有未声明或形状错误的 active RoleBinding；请重建专用本地数据库',
      );
    }
  }

  const existingKeys = new Set(existing.map(persistedBindingKey));
  for (const expected of EXPECTED_BINDINGS) {
    const principalId =
      expected.principalType === PrincipalType.USER
        ? requiredMapValue(userIdsByUsername, expected.username, 'User')
        : requiredMapValue(memberIdsByUsername, expected.username, 'Member');
    const roleId = requiredMapValue(roleIdsByCode, expected.roleCode, 'Role');
    const scopeOrgId = expected.scopeOrganization
      ? organizationIds[expected.scopeOrganization]
      : null;
    const key = bindingKey(
      expected.principalType,
      principalId,
      roleId,
      expected.scopeType,
      scopeOrgId,
    );
    if (existingKeys.has(key)) continue;

    await tx.roleBinding.create({
      data: {
        principalType: expected.principalType,
        principalId,
        roleId,
        scopeType: expected.scopeType,
        scopeOrgId,
        status: BindingStatus.ACTIVE,
        note: FIXTURE_NOTE,
      },
      select: { id: true },
    });
    existingKeys.add(key);
  }
}

export async function verifyLocalActivityFrontendFixture(prisma: PrismaClient): Promise<{
  accounts: number;
  memberships: number;
  roleBindings: number;
  organizationIds: Record<FixtureOrganizationKey, string>;
}> {
  return verifyFixtureDatabaseState(prisma);
}

async function verifyFixtureDatabaseState(db: FixtureDatabaseClient): Promise<{
  accounts: number;
  memberships: number;
  roleBindings: number;
  organizationIds: Record<FixtureOrganizationKey, string>;
}> {
  const roles = await loadAndValidateSeedRoles(db);
  await validateSeedDictionaries(db);
  const root = await db.organization.findUnique({
    where: { code: ROOT_ORGANIZATION_CODE },
    select: { id: true, parentId: true, status: true, deletedAt: true },
  });
  if (
    !root ||
    root.parentId !== null ||
    root.status !== OrganizationStatus.ACTIVE ||
    root.deletedAt !== null
  ) {
    throw new LocalActivityFrontendFixtureError('fixture verify：SRVF 根组织异常');
  }

  const organizationIds = {} as Record<FixtureOrganizationKey, string>;
  for (const expected of LOCAL_ACTIVITY_FRONTEND_ORGANIZATIONS) {
    const organization = await db.organization.findUnique({
      where: { code: expected.code },
      select: {
        id: true,
        name: true,
        parentId: true,
        nodeTypeCode: true,
        establishmentStatusCode: true,
        groupFunctionCode: true,
        sortOrder: true,
        status: true,
        deletedAt: true,
      },
    });
    if (
      !organization ||
      organization.name !== expected.name ||
      organization.parentId !== root.id ||
      organization.nodeTypeCode !== expected.nodeTypeCode ||
      organization.establishmentStatusCode !== null ||
      organization.groupFunctionCode !== null ||
      organization.sortOrder !== expected.sortOrder ||
      organization.status !== OrganizationStatus.ACTIVE ||
      organization.deletedAt !== null
    ) {
      throw new LocalActivityFrontendFixtureError(
        `fixture verify：组织 '${expected.code}' 缺失或形状漂移`,
      );
    }
    const closures = await db.organizationClosure.findMany({
      where: { descendantId: organization.id },
      select: { ancestorId: true, descendantId: true, depth: true },
    });
    assertEqualStringSets(
      closures.map((row) => `${row.ancestorId}:${row.descendantId}:${row.depth}`).sort(),
      [`${organization.id}:${organization.id}:0`, `${root.id}:${organization.id}:1`].sort(),
      `fixture verify：组织 '${expected.code}' closure 漂移`,
    );
    organizationIds[expected.key] = organization.id;
  }

  const users = await db.user.findMany({
    where: {
      username: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.username) },
    },
    select: {
      id: true,
      username: true,
      email: true,
      nickname: true,
      avatarKey: true,
      role: true,
      status: true,
      deletedAt: true,
      phone: true,
      phoneVerifiedAt: true,
      openid: true,
      memberId: true,
    },
  });
  if (users.length !== LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length) {
    throw new LocalActivityFrontendFixtureError(
      `fixture verify：期望 ${LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length} 个 User，实际 ${users.length}`,
    );
  }
  const usersByUsername = new Map(users.map((user) => [user.username, user]));

  const members = await db.member.findMany({
    where: {
      memberNo: { in: LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.map((account) => account.memberNo) },
    },
    select: {
      id: true,
      memberNo: true,
      displayName: true,
      gradeCode: true,
      status: true,
      deletedAt: true,
    },
  });
  if (members.length !== LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length) {
    throw new LocalActivityFrontendFixtureError(
      `fixture verify：期望 ${LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length} 个 Member，实际 ${members.length}`,
    );
  }
  const membersByMemberNo = new Map(members.map((member) => [member.memberNo, member]));
  const userIdsByUsername = new Map<string, string>();
  const memberIdsByUsername = new Map<string, string>();

  for (const expected of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    const member = membersByMemberNo.get(expected.memberNo);
    if (
      !member ||
      member.displayName !== expected.displayName ||
      member.gradeCode !== expected.gradeCode ||
      member.status !== MemberStatus.ACTIVE ||
      member.deletedAt !== null
    ) {
      throw new LocalActivityFrontendFixtureError(
        `fixture verify：Member '${expected.memberNo}' 缺失或形状漂移`,
      );
    }
    const user = usersByUsername.get(expected.username);
    if (!user) {
      throw new LocalActivityFrontendFixtureError(
        `fixture verify：User '${expected.username}' 缺失`,
      );
    }
    assertFixtureUserShape(user, expected, member.id);
    userIdsByUsername.set(expected.username, user.id);
    memberIdsByUsername.set(expected.username, member.id);
  }

  const activeLinkedUsers = await db.user.count({
    where: {
      memberId: { in: [...memberIdsByUsername.values()] },
      deletedAt: null,
    },
  });
  if (activeLinkedUsers !== LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length) {
    throw new LocalActivityFrontendFixtureError(
      'fixture verify：Member 与 active User 不是严格一对一',
    );
  }

  const memberships = await db.memberOrganizationMembership.findMany({
    where: {
      memberId: { in: [...memberIdsByUsername.values()] },
      status: MembershipStatus.ACTIVE,
      deletedAt: null,
    },
    select: {
      memberId: true,
      organizationId: true,
      membershipType: true,
      startedAt: true,
      endedAt: true,
      reason: true,
      createdByUserId: true,
      endedByUserId: true,
    },
  });
  if (memberships.length !== LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length) {
    throw new LocalActivityFrontendFixtureError(
      `fixture verify：期望 ${LOCAL_ACTIVITY_FRONTEND_ACCOUNTS.length} 个 active Membership，实际 ${memberships.length}`,
    );
  }
  for (const expected of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    const memberId = requiredMapValue(memberIdsByUsername, expected.username, 'Member');
    const matching = memberships.filter((membership) => membership.memberId === memberId);
    const membership = matching[0];
    if (
      matching.length !== 1 ||
      !membership ||
      membership.organizationId !== organizationIds[expected.organization] ||
      membership.membershipType !== MembershipType.PRIMARY ||
      membership.startedAt > new Date() ||
      membership.endedAt !== null ||
      membership.reason !== FIXTURE_NOTE ||
      membership.createdByUserId !== null ||
      membership.endedByUserId !== null
    ) {
      throw new LocalActivityFrontendFixtureError(
        `fixture verify：账号 '${expected.username}' 的 Membership 缺失、重复或漂移`,
      );
    }
  }

  const roleBindingNow = new Date();
  const roleBindings = await db.roleBinding.findMany({
    where: {
      status: BindingStatus.ACTIVE,
      deletedAt: null,
      OR: [
        {
          principalType: PrincipalType.USER,
          principalId: { in: [...userIdsByUsername.values()] },
        },
        {
          principalType: PrincipalType.MEMBER,
          principalId: { in: [...memberIdsByUsername.values()] },
        },
      ],
    },
    select: {
      principalType: true,
      principalId: true,
      roleId: true,
      scopeType: true,
      scopeOrgId: true,
      scopeActivityId: true,
      scopeResourceType: true,
      scopeResourceId: true,
      startedAt: true,
      endedAt: true,
      createdByUserId: true,
      note: true,
    },
  });
  if (roleBindings.length !== EXPECTED_BINDINGS.length) {
    throw new LocalActivityFrontendFixtureError(
      `fixture verify：期望 ${EXPECTED_BINDINGS.length} 个 active RoleBinding，实际 ${roleBindings.length}`,
    );
  }
  const actualBindingKeys = roleBindings.map((binding) => {
    if (
      binding.endedAt !== null ||
      binding.scopeActivityId !== null ||
      binding.scopeResourceType !== null ||
      binding.scopeResourceId !== null ||
      binding.startedAt > roleBindingNow ||
      binding.createdByUserId !== null ||
      binding.note !== FIXTURE_NOTE
    ) {
      throw new LocalActivityFrontendFixtureError(
        'fixture verify：RoleBinding 含未声明 scope、任期或审计主体',
      );
    }
    return persistedBindingKey(binding);
  });
  const expectedBindingKeys = EXPECTED_BINDINGS.map((binding) =>
    expectedBindingKey(binding, userIdsByUsername, memberIdsByUsername, organizationIds, roles),
  );
  assertEqualStringSets(
    actualBindingKeys.sort(),
    expectedBindingKeys.sort(),
    'fixture verify：RoleBinding 集合与 manifest 不一致',
  );

  const unrelatedAdminId = requiredMapValue(userIdsByUsername, 'local_fe_unrelated_admin', 'User');
  const legacyRole = await db.rbacRole.findUnique({
    where: { code: LEGACY_ACTIVITY_ROLE_CODE },
    select: { id: true },
  });
  if (legacyRole) {
    const legacyBinding = await db.roleBinding.findFirst({
      where: {
        principalType: PrincipalType.USER,
        principalId: unrelatedAdminId,
        roleId: legacyRole.id,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (legacyBinding) {
      throw new LocalActivityFrontendFixtureError(
        `fixture verify：local_fe_unrelated_admin 错误持有 '${LEGACY_ACTIVITY_ROLE_CODE}'`,
      );
    }
  }

  const managedRoleIds = SYSTEM_MANAGED_ROLE_CODES.map((code) =>
    requiredMapValue(roles, code, 'Role'),
  );
  const managedBindings = await db.roleBinding.count({
    where: {
      roleId: { in: managedRoleIds },
      status: BindingStatus.ACTIVE,
      deletedAt: null,
    },
  });
  if (managedBindings !== 0) {
    throw new LocalActivityFrontendFixtureError(
      'fixture verify：初始环境存在 active owner/collaborator 系统 RoleBinding',
    );
  }
  const responsibilityAssignments = await db.activityResponsibilityAssignment.count({
    where: { status: 'active' },
  });
  if (responsibilityAssignments !== 0) {
    throw new LocalActivityFrontendFixtureError(
      'fixture verify：初始环境存在 active ActivityResponsibilityAssignment',
    );
  }
  const businessRecordCounts = await Promise.all([
    db.activity.count(),
    db.activityPublishReview.count(),
    db.activityRegistration.count(),
    db.activityCheckIn.count(),
    db.attendanceSheet.count(),
    db.attendanceRecord.count(),
    db.activityFeedback.count(),
  ]);
  if (businessRecordCounts.some((count) => count !== 0)) {
    throw new LocalActivityFrontendFixtureError(
      `fixture verify：专用库不是初始空业务态（activity/review/registration/check-in/sheet/record/feedback=${businessRecordCounts.join(
        '/',
      )}）；请执行 guarded rebuild`,
    );
  }

  return {
    accounts: users.length,
    memberships: memberships.length,
    roleBindings: roleBindings.length,
    organizationIds,
  };
}

function expectedBindingKey(
  expected: ExpectedBinding,
  userIdsByUsername: Map<string, string>,
  memberIdsByUsername: Map<string, string>,
  organizationIds: Record<FixtureOrganizationKey, string>,
  roleIdsByCode: Map<string, string>,
): string {
  const principalId =
    expected.principalType === PrincipalType.USER
      ? requiredMapValue(userIdsByUsername, expected.username, 'User')
      : requiredMapValue(memberIdsByUsername, expected.username, 'Member');
  return bindingKey(
    expected.principalType,
    principalId,
    requiredMapValue(roleIdsByCode, expected.roleCode, 'Role'),
    expected.scopeType,
    expected.scopeOrganization ? organizationIds[expected.scopeOrganization] : null,
  );
}

function persistedBindingKey(binding: {
  principalType: PrincipalType;
  principalId: string | null;
  roleId: string;
  scopeType: BindingScopeType;
  scopeOrgId: string | null;
}): string {
  if (!binding.principalId) {
    throw new LocalActivityFrontendFixtureError('fixture RoleBinding principalId 不能为空');
  }
  return bindingKey(
    binding.principalType,
    binding.principalId,
    binding.roleId,
    binding.scopeType,
    binding.scopeOrgId,
  );
}

function bindingKey(
  principalType: PrincipalType,
  principalId: string,
  roleId: string,
  scopeType: BindingScopeType,
  scopeOrgId: string | null,
): string {
  return [principalType, principalId, roleId, scopeType, scopeOrgId ?? '-'].join(':');
}

function requiredMapValue(values: Map<string, string>, key: string, kind: string): string {
  const value = values.get(key);
  if (!value) {
    throw new LocalActivityFrontendFixtureError(`fixture ${kind} '${key}' 缺失`);
  }
  return value;
}

function assertEqualStringSets(actual: string[], expected: string[], message: string): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new LocalActivityFrontendFixtureError(
      `${message}；expected=[${expected.join(', ')}] actual=[${actual.join(', ')}]`,
    );
  }
}

async function verifyLocalActivityFrontendHttp(
  baseUrlValue: string,
  password: string,
  fetchImpl: typeof fetch,
  organizationIds: Record<FixtureOrganizationKey, string>,
): Promise<'passed'> {
  const baseUrl = assertLoopbackApiBaseUrl(baseUrlValue);
  const live = await requestWrappedData(fetchImpl, baseUrl, '/api/system/v1/health/live');
  assertNoL3Fields(live.response);
  if (!isRecord(live.data) || live.data.status !== 'ok') {
    throw new LocalActivityFrontendFixtureError('HTTP verify：health/live 未返回 status=ok');
  }

  const ready = await requestWrappedData(fetchImpl, baseUrl, '/api/system/v1/health/ready');
  assertNoL3Fields(ready.response);
  if (!isRecord(ready.data) || ready.data.status !== 'ok' || ready.data.db !== 'up') {
    throw new LocalActivityFrontendFixtureError(
      'HTTP verify：health/ready 未返回 status=ok 且 db=up',
    );
  }

  const capabilitiesByUsername = new Map<string, Record<string, unknown>>();
  const organizationOptionsByUsername = new Map<string, Array<Record<string, unknown>>>();

  for (const account of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    const login = await requestWrappedData(fetchImpl, baseUrl, '/api/auth/v1/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: account.username, password }),
    });
    const accessToken = assertFrozenLoginResponseData(login.data, account.username);
    // 冻结的登录契约会返回 refreshToken，并创建 refresh session / login audit。
    // 这里只在当前迭代的局部作用域中使用 accessToken，登录 payload 不进入日志。
    const authorization = { authorization: `Bearer ${accessToken}` };

    const capabilities = await requestWrappedData(
      fetchImpl,
      baseUrl,
      '/api/app/v1/me/capabilities',
      { headers: authorization },
    );
    assertNoL3Fields(capabilities.response);
    if (!isRecord(capabilities.data)) {
      throw new LocalActivityFrontendFixtureError(
        `HTTP verify：账号 '${account.username}' capabilities 响应形状错误`,
      );
    }
    capabilitiesByUsername.set(account.username, capabilities.data);

    if (isFormalFixtureAccount(account)) {
      const organizationOptions = await requestWrappedData(
        fetchImpl,
        baseUrl,
        '/api/app/v1/my/managed-activities/organization-options',
        { headers: authorization },
      );
      assertNoL3Fields(organizationOptions.response);
      if (
        !Array.isArray(organizationOptions.data) ||
        organizationOptions.data.some((item) => !isRecord(item))
      ) {
        throw new LocalActivityFrontendFixtureError(
          `HTTP verify：账号 '${account.username}' organization-options 响应形状错误`,
        );
      }
      organizationOptionsByUsername.set(
        account.username,
        organizationOptions.data as Array<Record<string, unknown>>,
      );
    }
  }

  for (const account of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    const capabilities = requiredRecordMapValue(
      capabilitiesByUsername,
      account.username,
      'capabilities',
    );
    const expectedCanInitiate = isFormalFixtureAccount(account);
    const actualCanInitiate = readNestedBoolean(capabilities, [
      'activities',
      'canInitiateActivity',
    ]);
    if (actualCanInitiate !== expectedCanInitiate) {
      throw new LocalActivityFrontendFixtureError(
        `HTTP verify：账号 '${account.username}' canInitiateActivity 期望 ${expectedCanInitiate}，实际 ${actualCanInitiate}`,
      );
    }
  }

  assertManagedCapability(
    capabilitiesByUsername,
    'local_fe_publish_reviewer',
    'canReviewActivityPublication',
    true,
  );
  for (const username of ['local_fe_first_a', 'local_fe_first_b']) {
    assertManagedCapability(capabilitiesByUsername, username, 'canFirstReviewAttendance', true);
  }
  for (const username of ['local_fe_final_a', 'local_fe_final_b']) {
    assertManagedCapability(capabilitiesByUsername, username, 'canFinalReviewAttendance', true);
  }
  for (const key of [
    'canReviewActivityPublication',
    'canFirstReviewAttendance',
    'canFinalReviewAttendance',
    'canManageManagedRegistrations',
    'canSubmitManagedAttendance',
  ]) {
    assertManagedCapability(capabilitiesByUsername, 'local_fe_unrelated_admin', key, false);
  }

  const ownerOptions = requiredRecordArrayMapValue(organizationOptionsByUsername, 'local_fe_owner');
  assertOrganizationOption(ownerOptions, organizationIds.A, 'membership', true);
  assertOrganizationOption(ownerOptions, organizationIds.B, undefined, false);

  const crossOrgOptions = requiredRecordArrayMapValue(
    organizationOptionsByUsername,
    'local_fe_cross_org',
  );
  assertOrganizationOption(crossOrgOptions, organizationIds.A, 'membership', true);
  assertOrganizationOption(crossOrgOptions, organizationIds.B, 'cross-org-grant', true);

  return 'passed';
}

function isFormalFixtureAccount(account: FixtureAccount): boolean {
  return account.gradeCode !== null && /^level-[1-7]$/.test(account.gradeCode);
}

function assertLoopbackApiBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalActivityFrontendFixtureError('LOCAL_API_BASE_URL 不是合法 URL');
  }
  const allowedHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !allowedHostnames.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new LocalActivityFrontendFixtureError(
      'LOCAL_API_BASE_URL 只允许无凭据、无路径的本机 http(s) 地址',
    );
  }
  url.pathname = '/';
  return url;
}

export async function requestWrappedData(
  fetchImpl: typeof fetch,
  baseUrl: URL,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Record<string, unknown>; data: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LocalActivityFrontendFixtureError(`HTTP verify：${path} 请求失败`);
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：${path} 返回非 JSON（HTTP ${response.status}）`,
    );
  }
  if (!isRecord(body)) {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：${path} 响应不是包装对象（HTTP ${response.status}）`,
    );
  }
  if (!response.ok || body.code !== 0) {
    const code = typeof body.code === 'number' ? body.code : 'unknown';
    const suffix =
      response.status === 429 ? '；请把专用本地后端 LOGIN_THROTTLE_LIMIT 设为至少 50 后重启' : '';
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：${path} 失败（HTTP ${response.status}, BizCode ${code}）${suffix}`,
    );
  }
  return { response: body, data: body.data };
}

export function assertNoL3Fields(value: unknown): void {
  const forbiddenKeyPattern = /(?:passwordHash|token|secret|session[_-]?key|signedUrl)/i;
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, nested] of Object.entries(current)) {
      if (forbiddenKeyPattern.test(key)) {
        throw new LocalActivityFrontendFixtureError(
          `HTTP verify：业务 GET 响应出现 L3 字段 '${path}.${key}'`,
        );
      }
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value, '$');
}

export function assertFrozenLoginResponseData(value: unknown, username: string): string {
  if (!isRecord(value)) {
    throw new LocalActivityFrontendFixtureError(`HTTP verify：账号 '${username}' 登录响应不是对象`);
  }
  const expectedKeys = [
    'accessToken',
    'expiresIn',
    'refreshExpiresAt',
    'refreshToken',
    'tokenType',
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：账号 '${username}' 登录响应字段集偏离冻结的五字段契约`,
    );
  }
  if (
    typeof value.accessToken !== 'string' ||
    value.accessToken.length === 0 ||
    value.tokenType !== 'Bearer' ||
    typeof value.expiresIn !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    value.refreshToken.length === 0 ||
    typeof value.refreshExpiresAt !== 'string'
  ) {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：账号 '${username}' 登录响应字段类型偏离冻结契约`,
    );
  }
  return value.accessToken;
}

function readNestedBoolean(
  value: Record<string, unknown>,
  path: readonly [string, string],
): boolean {
  const parent = value[path[0]];
  const nested = isRecord(parent) ? parent[path[1]] : undefined;
  if (typeof nested !== 'boolean') {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：响应缺少 boolean 字段 ${path.join('.')}`,
    );
  }
  return nested;
}

function assertManagedCapability(
  capabilitiesByUsername: Map<string, Record<string, unknown>>,
  username: string,
  key: string,
  expected: boolean,
): void {
  const capabilities = requiredRecordMapValue(capabilitiesByUsername, username, 'capabilities');
  const actual = readNestedBoolean(capabilities, ['managed', key]);
  if (actual !== expected) {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：账号 '${username}' managed.${key} 期望 ${expected}，实际 ${actual}`,
    );
  }
}

function assertOrganizationOption(
  options: Array<Record<string, unknown>>,
  organizationId: string,
  expectedSource: string | undefined,
  expectedPresent: boolean,
): void {
  const matching = options.filter((option) => option.organizationId === organizationId);
  if (!expectedPresent && matching.length !== 0) {
    throw new LocalActivityFrontendFixtureError(
      'HTTP verify：organization-options 暴露了不应出现的组织',
    );
  }
  if (
    expectedPresent &&
    (matching.length !== 1 || (expectedSource && matching[0]?.source !== expectedSource))
  ) {
    throw new LocalActivityFrontendFixtureError(
      `HTTP verify：organization-options 缺少预期来源 '${expectedSource ?? 'any'}'`,
    );
  }
}

function requiredRecordMapValue(
  values: Map<string, Record<string, unknown>>,
  key: string,
  kind: string,
): Record<string, unknown> {
  const value = values.get(key);
  if (!value) {
    throw new LocalActivityFrontendFixtureError(`HTTP verify：${kind} '${key}' 缺失`);
  }
  return value;
}

function requiredRecordArrayMapValue(
  values: Map<string, Array<Record<string, unknown>>>,
  key: string,
): Array<Record<string, unknown>> {
  const value = values.get(key);
  if (!value) {
    throw new LocalActivityFrontendFixtureError(`HTTP verify：organization-options '${key}' 缺失`);
  }
  return value;
}

export function renderFixtureAccountManifest(): string {
  const lines = [
    'Local activity frontend fixture account manifest',
    'Organizations: A=Local Organization A; B=Local Organization B',
    'All accounts use the password supplied through LOCAL_FRONTEND_FIXTURE_PASSWORD.',
    'username | organization | duty | page',
  ];
  for (const account of LOCAL_ACTIVITY_FRONTEND_ACCOUNTS) {
    lines.push(`${account.username} | ${account.organization} | ${account.duty} | ${account.page}`);
  }
  return lines.join('\n');
}

export function renderGuardedCleanupInstructions(database: string): string {
  if (!LOCAL_DATABASE_PATTERN.test(database) || database.length > 63) {
    throw new LocalActivityFrontendFixtureError('cleanup 数据库名不符合专用本地联调库规则');
  }
  return [
    `Guarded manual rebuild for dedicated database '${database}'`,
    'This command made zero database connections and zero writes.',
    'Stop the local backend first, review the confirmed database name, then run manually:',
    `docker exec u-nest-api-postgres dropdb -U postgres --if-exists ${database}`,
    `docker exec u-nest-api-postgres createdb -U postgres ${database}`,
    'pnpm prisma:deploy',
    'pnpm prisma:seed',
    'pnpm local:activity-fixture:setup',
    'pnpm local:activity-fixture:verify',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
