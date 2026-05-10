import { PrismaClient, Role, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

// v1 唯一允许创建 SUPER_ADMIN 的入口(详见 ARCHITECTURE.md §7.11 + §8 + §13)。
// seed 直接读 process.env(§14 显式例外):SUPER_ADMIN_* 不进 ConfigService,
// 避免运行时被业务代码误读到默认凭据。
//
// 启动强校验:
// - SUPER_ADMIN_USERNAME 必须符合 username 格式(归一化后小写)
// - SUPER_ADMIN_PASSWORD 必须设置
// - APP_ENV=production 时禁用默认 username 'admin' 与默认 password 'ChangeMe123456'
//
// 幂等性:用户已存在时 **不覆盖** 密码 / 角色 / 邮箱,只打印提示。
//
// V2 第一阶段(详见 docs/v2-plan.md §2.2 / docs/v2-data-model.md §2-§3):
// SUPER_ADMIN 处理之后追加 neutral-demo 字典 seed。
// - dict_types: node_type / member_grade
// - 每类放抽象占位 dict_items;真实部门名 / 等级名 / 队员编号不进 git history(R13)
// - upsert + update: {} 实现幂等,不覆盖运营在运行时手动调整的取值
//
// V2 第一阶段批次 1 追加(详见 docs:批次1_schema草案_member_profiles_emergency_contacts.md
// v1.0 冻结版 §12.1 + 决议表 Q-S04 / Q-S06):
// 必开 6 个字典 type:emergency_relation / gender / document_type / political_status /
// blood_type / work_nature。占位 items 为演示数据;真实运营录入由队部决定。
//
// V2 第一阶段批次 2 追加(详见 docs:批次2_schema草案_certificates.md v1.0 冻结版 §12.1
// + 决议表 Q-D7):
// 必开 3 个字典 type:cert_type / cert_sub_type / cert_status。
// 风格:英文 code + 中文 label(Q-D7 决议),与批次 1 demo label 不同;
//   - cert_type: 7 项占位(救护员 / BSAFE / 户外 / 教练 / 通讯 / 医疗 / 其他)
//   - cert_sub_type: 4 项演示占位(BSAFE 一/二级 + 救护员基础/高级)
//   - cert_status: 4 态闭集(待核验 / 已核验 / 已失效 / 拒绝),新增态需走前评审
// 真实 items 由队部 / TTD 后续运营层录入(Q-S1)。

const DEFAULT_PASSWORD = 'ChangeMe123456';
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;
const BCRYPT_SALT_ROUNDS = 10;

// V2 neutral-demo 字典 seed:仅占位,真实业务取值由运营在部署后通过运营后台 / 私有 seed 录入。
// - type code 用 snake_case,与字段名 organizations.nodeTypeCode / members.gradeCode 对齐
// - dict_items 全部 parentId = null(顶层);父子树形 V2.x 评估再引入
const V2_DICT_SEED = [
  {
    type: { code: 'node_type', label: 'Demo node type', sortOrder: 0 },
    items: [
      { code: 'demo-node-type-1', label: 'Demo node type 1', sortOrder: 0 },
      { code: 'demo-node-type-2', label: 'Demo node type 2', sortOrder: 1 },
    ],
  },
  {
    type: { code: 'member_grade', label: 'Demo member grade', sortOrder: 1 },
    items: [
      { code: 'demo-member-grade-1', label: 'Demo member grade 1', sortOrder: 0 },
      { code: 'demo-member-grade-2', label: 'Demo member grade 2', sortOrder: 1 },
    ],
  },
  // ===== V2 第一阶段批次 1 追加 6 个字典 =====
  {
    type: { code: 'emergency_relation', label: 'Demo emergency contact relation', sortOrder: 2 },
    items: [
      { code: 'family', label: 'Demo family', sortOrder: 0 },
      { code: 'friend', label: 'Demo friend', sortOrder: 1 },
      { code: 'spouse', label: 'Demo spouse', sortOrder: 2 },
      { code: 'parent', label: 'Demo parent', sortOrder: 3 },
      { code: 'child', label: 'Demo child', sortOrder: 4 },
      { code: 'other', label: 'Demo other', sortOrder: 5 },
    ],
  },
  {
    type: { code: 'gender', label: 'Demo gender', sortOrder: 3 },
    items: [
      { code: 'demo-gender-1', label: 'Demo gender 1', sortOrder: 0 },
      { code: 'demo-gender-2', label: 'Demo gender 2', sortOrder: 1 },
    ],
  },
  {
    type: { code: 'document_type', label: 'Demo document type', sortOrder: 4 },
    items: [
      { code: 'demo-doc-type-1', label: 'Demo document type 1', sortOrder: 0 },
      { code: 'demo-doc-type-2', label: 'Demo document type 2', sortOrder: 1 },
      { code: 'demo-doc-type-3', label: 'Demo document type 3', sortOrder: 2 },
      { code: 'demo-doc-type-4', label: 'Demo document type 4', sortOrder: 3 },
    ],
  },
  {
    type: { code: 'political_status', label: 'Demo political status', sortOrder: 5 },
    items: [
      { code: 'demo-political-1', label: 'Demo political 1', sortOrder: 0 },
      { code: 'demo-political-2', label: 'Demo political 2', sortOrder: 1 },
      { code: 'demo-political-3', label: 'Demo political 3', sortOrder: 2 },
    ],
  },
  {
    type: { code: 'blood_type', label: 'Demo blood type', sortOrder: 6 },
    items: [
      { code: 'demo-blood-A', label: 'Demo A', sortOrder: 0 },
      { code: 'demo-blood-B', label: 'Demo B', sortOrder: 1 },
      { code: 'demo-blood-AB', label: 'Demo AB', sortOrder: 2 },
      { code: 'demo-blood-O', label: 'Demo O', sortOrder: 3 },
    ],
  },
  {
    type: { code: 'work_nature', label: 'Demo work nature', sortOrder: 7 },
    items: [
      { code: 'demo-work-1', label: 'Demo work 1', sortOrder: 0 },
      { code: 'demo-work-2', label: 'Demo work 2', sortOrder: 1 },
      { code: 'demo-work-3', label: 'Demo work 3', sortOrder: 2 },
      { code: 'demo-work-4', label: 'Demo work 4', sortOrder: 3 },
    ],
  },
  // ===== V2 第一阶段批次 2 追加 3 个字典(英文 code + 中文 label,Q-D7)=====
  {
    type: { code: 'cert_type', label: '证书大类', sortOrder: 8 },
    items: [
      { code: 'first_aid', label: '救护员', sortOrder: 0 },
      { code: 'bsafe', label: 'BSAFE', sortOrder: 1 },
      { code: 'outdoor', label: '户外', sortOrder: 2 },
      { code: 'coach', label: '教练', sortOrder: 3 },
      { code: 'comm', label: '通讯', sortOrder: 4 },
      { code: 'medical', label: '医疗', sortOrder: 5 },
      { code: 'other', label: '其他', sortOrder: 6 },
    ],
  },
  {
    type: { code: 'cert_sub_type', label: '证书等级 / 子类型', sortOrder: 9 },
    items: [
      { code: 'bsafe_l1', label: 'BSAFE 一级', sortOrder: 0 },
      { code: 'bsafe_l2', label: 'BSAFE 二级', sortOrder: 1 },
      { code: 'first_aid_basic', label: '救护员基础', sortOrder: 2 },
      { code: 'first_aid_advanced', label: '救护员高级', sortOrder: 3 },
    ],
  },
  {
    type: { code: 'cert_status', label: '核验状态', sortOrder: 10 },
    items: [
      { code: 'pending', label: '待核验', sortOrder: 0 },
      { code: 'verified', label: '已核验', sortOrder: 1 },
      { code: 'expired', label: '已失效', sortOrder: 2 },
      { code: 'rejected', label: '拒绝', sortOrder: 3 },
    ],
  },
] as const;

async function seedV2Dictionaries(prisma: PrismaClient): Promise<void> {
  for (const entry of V2_DICT_SEED) {
    // 已存在则不覆盖 label / sortOrder / status,防止运营运行时调整被 seed 回退
    const dictType = await prisma.dictType.upsert({
      where: { code: entry.type.code },
      update: {},
      create: {
        code: entry.type.code,
        label: entry.type.label,
        sortOrder: entry.type.sortOrder,
      },
      select: { id: true, code: true },
    });

    for (const item of entry.items) {
      // 复合唯一键 typeId_code 由 schema @@unique([typeId, code]) Prisma 自动生成
      await prisma.dictItem.upsert({
        where: {
          typeId_code: {
            typeId: dictType.id,
            code: item.code,
          },
        },
        update: {},
        create: {
          typeId: dictType.id,
          code: item.code,
          label: item.label,
          sortOrder: item.sortOrder,
        },
      });
    }

    console.log(
      `[seed] V2 dict '${entry.type.code}' ensured (${entry.items.length} items, neutral-demo)`,
    );
  }
}

async function main(): Promise<void> {
  const usernameRaw = process.env.SUPER_ADMIN_USERNAME ?? '';
  const username = usernameRaw.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD ?? '';
  const emailRaw = process.env.SUPER_ADMIN_EMAIL ?? '';
  const emailNormalized = emailRaw.trim().toLowerCase();
  // 空字符串视为未填写(不写入 email 字段);保持 §5 + §3 字段校验铁律一致
  const email: string | undefined = emailNormalized === '' ? undefined : emailNormalized;
  const env = process.env.APP_ENV;

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      `[seed] SUPER_ADMIN_USERNAME 格式无效:"${usernameRaw}";归一化后必须匹配 ${USERNAME_PATTERN.toString()}`,
    );
  }
  if (!password) {
    throw new Error('[seed] SUPER_ADMIN_PASSWORD 未设置');
  }

  if (env === 'production') {
    if (username === 'admin') {
      throw new Error(
        '[seed] APP_ENV=production 时禁止 SUPER_ADMIN_USERNAME=admin(默认值过于通用)',
      );
    }
    if (password === DEFAULT_PASSWORD) {
      throw new Error(
        `[seed] APP_ENV=production 时禁止 SUPER_ADMIN_PASSWORD='${DEFAULT_PASSWORD}'(.env.example 默认值)`,
      );
    }
  }

  const prisma = new PrismaClient();
  try {
    // 唯一性预检查必须用 findUnique 包含软删记录(详见 §7.8)
    const existing = await prisma.user.findUnique({
      where: { username },
      select: { id: true, role: true, status: true, deletedAt: true },
    });

    if (existing) {
      console.log(
        `[seed] User '${username}' already exists ` +
          `(id=${existing.id}, role=${existing.role}, status=${existing.status}, ` +
          `deletedAt=${existing.deletedAt ? existing.deletedAt.toISOString() : 'null'}); ` +
          'skipping. No password / role / email is overwritten.',
      );
    } else {
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      const created = await prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          role: Role.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
        },
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });
      console.log('[seed] Created super admin:');
      console.log(JSON.stringify(created, null, 2));
    }

    // V2 第一阶段:无论 SUPER_ADMIN 是否新建,都追加 neutral-demo 字典 seed
    await seedV2Dictionaries(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
