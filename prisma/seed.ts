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
//
// V2 第一阶段批次 3 追加(详见 docs:批次3_schema草案_activities_attendances.md v0.5 §10
// + 决议表 v1.4):
// 必开 6 个字典 type:activity_type / activity_status / registration_status /
// attendance_sheet_status / attendance_status / attendance_role。
//   - activity_type: 开放,**二级树**(D11);由独立函数 seedActivityTypeHierarchy 处理
//     父子 upsert(parentId 引用同 type 父项 id)
//   - activity_status: 闭集 4 态(D3;Q-D7 保留 completed):draft/published/cancelled/completed
//   - registration_status: 闭集 **4 态**(F28/Q011 + Q-D15 v0.3 新增 cancelled):
//     pending/pass/reject/cancelled
//   - attendance_sheet_status: 闭集 3 态(D18,v0.4.0):pending/approved/rejected
//     **v0.5.0 批次 4-A 扩展为 5 态**(D-S6):新增 pending_final_review + final_rejected
//   - attendance_status: 闭集 **3 态**(D44/D51 v0.2.4 撤销 absent/leave):
//     present/late/early_leave
//   - attendance_role: 闭集 7 项(D13):member/instructor/assistant/coach/
//     front_command/back_command/info
// 风格沿批次 2:英文 code + 中文 label。
//
// V2 第一阶段批次 4-A 追加(详见 docs:批次4_贡献值业务规则_schema草案评审决议表 v1.0 D-S6 + 字典扩展决议表 v1.0):
// - attendance_sheet_status 字典扩展 3 → 5 态(D-S6);见 V2_DICT_SEED 内对应条目
// - ContributionRule **不在 seed 中预填真实规则**(字典扩展决议 §4.1 选项 A);
//   运营后台 / 私有 seed 录入,真实计分规则不进 git history(沿 baseline §0.3 / R13)
// - activity_type / attendance_role **沿 v0.4.0 neutral-demo 占位**;真实子项 / 角色由运营后台维护
//
// V2.x C-6 RBAC 实施 PR #8 追加(2026-05-14;沿 D7 v1.1 §10 + 用户拍板六项决策):
// 1. 14 条 rbac.* Permission 全集 upsert(D7 §10.2;**跳过 4 条 attachment.***,
//    因 D7 §10.2 attachment.* 是 4 段 code,与 PR #2 实装的 Permission code 3 段正则冲突,
//    留 C-7 attachments 启动时另行评审正则或 code 命名 — 用户拍板方案 A)
// 2. 公开 seed 只创建 `ops-admin` RbacRole(用户拍板方案 A);**不**写真实部门名 / 真实职务名 /
//    role-a..role-f placeholder;业务角色由后续运营通过 API 创建,或 .env.seed.local 私有 seed
// 3. RolePermission 映射:ops-admin → 全部 14 条 rbac.*(D7 §10.3)
// 4. bootstrap user_role(D7 §10.4):
//    - `RBAC_INITIAL_OPS_ADMIN_USER_ID` env 优先指定首个 ops-admin 持有者
//    - 无 env 时 fallback 到现有 SUPER_ADMIN(seed 阶段刚创建的或已存在的)
//    - 强校验:seed 完成后 **至少 1 个 user_role 持有 ops-admin**,否则 throw 退出
// 5. **不** 写 audit_logs(seed 是 bootstrap 离线工具;D7 §11 audit 是运行时 API 写操作审计)
// 6. **不** 创建"ADMIN 内置角色"(用户拍板方案 A;留业务模块 RBAC 接入 PR 落地)
// 7. 全部 upsert 幂等:重复跑不重复创建 / 不覆盖运营运行时调整

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
  // ===== V2 第一阶段批次 3 追加 5 个闭集字典 =====
  // 注:activity_type(sortOrder=11)是二级树,由独立函数 seedActivityTypeHierarchy 处理。
  {
    type: { code: 'activity_status', label: '活动状态', sortOrder: 12 },
    items: [
      { code: 'draft', label: '草稿', sortOrder: 0 },
      { code: 'published', label: '已发布', sortOrder: 1 },
      { code: 'cancelled', label: '已取消', sortOrder: 2 },
      { code: 'completed', label: '已完成', sortOrder: 3 }, // Q-D7 保留 dict seed
    ],
  },
  {
    type: { code: 'registration_status', label: '报名状态', sortOrder: 13 },
    items: [
      { code: 'pending', label: '待审核', sortOrder: 0 },
      { code: 'pass', label: '已通过', sortOrder: 1 },
      { code: 'reject', label: '未通过', sortOrder: 2 },
      { code: 'cancelled', label: '已取消', sortOrder: 3 }, // Q-D15 v0.3 新增
    ],
  },
  {
    // V2 第一阶段批次 4-A 扩展(D-S6):3 态 → 5 态,新增 pending_final_review / final_rejected。
    // approved 语义升级为"终审通过"(从原"APD 通过"升级);字段字符串值不变,仅业务语义升级,
    // 走 PR C CHANGELOG announcement;OpenAPI snapshot 中 statusCode enum 扩展为 non-breaking。
    // 详见 docs/批次4_贡献值业务规则_schema草案评审决议表.md v1.0 D-S6。
    type: { code: 'attendance_sheet_status', label: '考勤单据状态', sortOrder: 14 },
    items: [
      { code: 'pending', label: '待 APD 审核', sortOrder: 0 },
      { code: 'pending_final_review', label: 'APD 已审,待终审', sortOrder: 1 },
      { code: 'approved', label: '终审通过', sortOrder: 2 },
      { code: 'rejected', label: 'APD 驳回', sortOrder: 3 },
      { code: 'final_rejected', label: '终审驳回', sortOrder: 4 },
    ],
  },
  {
    type: { code: 'attendance_status', label: '考勤明细状态', sortOrder: 15 },
    // v0.2.4 D44 / D51:从 5 态收窄为 3 态;absent / leave 不进 Record(D43)
    items: [
      { code: 'present', label: '已到场', sortOrder: 0 },
      { code: 'late', label: '迟到', sortOrder: 1 },
      { code: 'early_leave', label: '早退', sortOrder: 2 },
    ],
  },
  {
    type: { code: 'attendance_role', label: '考勤角色', sortOrder: 16 },
    // D13:7 项闭集
    items: [
      { code: 'member', label: '队员', sortOrder: 0 },
      { code: 'instructor', label: '讲师', sortOrder: 1 },
      { code: 'assistant', label: '助教', sortOrder: 2 },
      { code: 'coach', label: '教练', sortOrder: 3 },
      { code: 'front_command', label: '前指', sortOrder: 4 },
      { code: 'back_command', label: '后指', sortOrder: 5 },
      { code: 'info', label: '信息', sortOrder: 6 },
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

// V2 第一阶段批次 3:activity_type 二级树字典(D11 / Q-S17;允许挂顶级父项)。
// 由于父子项需要 parentId 引用,无法走 V2_DICT_SEED 单层 upsert;独立函数处理:
// ① upsert dict_type 取 id
// ② upsert 父项取 id(parentMap 缓存)
// ③ upsert 子项,parentId 从 parentMap 取
// 幂等性:upsert + update: {} 保证;父子项顺序由本函数控制(先父后子)。
//
// 占位 seed 形态(Q-S11):
// - `demo-` 前缀英文 code + 中文演示 label
// - 3 父项(演示-轮值 / 演示-培训 / 演示-行动)
// - 4 子项(演示-梧桐山轮值 / 演示-梅林轮值 / 演示-基础培训 / 演示-初级救援培训)
// - `demo-action` 父项故意无子项,演示 Q-S17 决议"允许挂顶级"
// 真实节点名由队部 / 秘书处后续运营层录入。
async function seedActivityTypeHierarchy(prisma: PrismaClient): Promise<void> {
  const dictType = await prisma.dictType.upsert({
    where: { code: 'activity_type' },
    update: {},
    create: {
      code: 'activity_type',
      label: '活动类型',
      sortOrder: 11,
    },
    select: { id: true },
  });

  const parents = [
    { code: 'demo-rotation', label: '演示-轮值', sortOrder: 0 },
    { code: 'demo-training', label: '演示-培训', sortOrder: 1 },
    { code: 'demo-action', label: '演示-行动', sortOrder: 2 },
  ];

  const parentMap = new Map<string, string>();
  for (const p of parents) {
    const item = await prisma.dictItem.upsert({
      where: { typeId_code: { typeId: dictType.id, code: p.code } },
      update: {},
      create: {
        typeId: dictType.id,
        code: p.code,
        label: p.label,
        sortOrder: p.sortOrder,
      },
      select: { id: true, code: true },
    });
    parentMap.set(item.code, item.id);
  }

  const children = [
    {
      code: 'demo-rotation-wutongshan',
      label: '演示-梧桐山轮值',
      sortOrder: 0,
      parentCode: 'demo-rotation',
    },
    {
      code: 'demo-rotation-meilin',
      label: '演示-梅林轮值',
      sortOrder: 1,
      parentCode: 'demo-rotation',
    },
    {
      code: 'demo-training-basic',
      label: '演示-基础培训',
      sortOrder: 0,
      parentCode: 'demo-training',
    },
    {
      code: 'demo-training-rescue',
      label: '演示-初级救援培训',
      sortOrder: 1,
      parentCode: 'demo-training',
    },
  ];

  for (const c of children) {
    const parentId = parentMap.get(c.parentCode);
    if (!parentId) {
      throw new Error(`[seed] activity_type 父项 '${c.parentCode}' 不存在`);
    }
    await prisma.dictItem.upsert({
      where: { typeId_code: { typeId: dictType.id, code: c.code } },
      update: {},
      create: {
        typeId: dictType.id,
        code: c.code,
        label: c.label,
        sortOrder: c.sortOrder,
        parentId,
      },
    });
  }

  console.log(
    `[seed] V2 dict 'activity_type' ensured (${parents.length} 父项 + ${children.length} 子项,二级树,demo)`,
  );
}

// V2.x C-6 RBAC 实施 PR #8(2026-05-14):14 条 rbac.* 权限点全集(沿 D7 v1.1 §10.2)。
// 跳过 4 条 attachment.*(沿用户拍板方案 A;留 C-7 attachments)。
// 注:code 必须满足 PR #2 实装的 Permission code 正则 `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$`
// (固定 3 段;首段小写字母开头);本表全部 14 条均符合。
interface RbacPermissionSeed {
  code: string;
  module: string;
  action: string;
  resourceType: string;
  description: string;
}

const RBAC_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  // rbac.permission.* (4):权限点 CRUD(沿 D7 §10.2)
  {
    code: 'rbac.permission.read',
    module: 'rbac',
    action: 'read',
    resourceType: 'permission',
    description: '查看权限点',
  },
  {
    code: 'rbac.permission.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'permission',
    description: '创建权限点',
  },
  {
    code: 'rbac.permission.update',
    module: 'rbac',
    action: 'update',
    resourceType: 'permission',
    description: '更新权限点',
  },
  {
    code: 'rbac.permission.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'permission',
    description: '删除权限点',
  },
  // rbac.role.* (4)
  {
    code: 'rbac.role.read',
    module: 'rbac',
    action: 'read',
    resourceType: 'role',
    description: '查看角色',
  },
  {
    code: 'rbac.role.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'role',
    description: '创建角色',
  },
  {
    code: 'rbac.role.update',
    module: 'rbac',
    action: 'update',
    resourceType: 'role',
    description: '更新角色',
  },
  {
    code: 'rbac.role.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'role',
    description: '软删角色',
  },
  // rbac.role-permission.* (2)
  {
    code: 'rbac.role-permission.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'role-permission',
    description: '角色加权限点',
  },
  {
    code: 'rbac.role-permission.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'role-permission',
    description: '撤角色权限点',
  },
  // rbac.user-role.* (3)
  {
    code: 'rbac.user-role.read',
    module: 'rbac',
    action: 'read',
    resourceType: 'user-role',
    description: '查看用户角色',
  },
  {
    code: 'rbac.user-role.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'user-role',
    description: '分配用户角色',
  },
  {
    code: 'rbac.user-role.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'user-role',
    description: '撤用户角色',
  },
  // rbac.config.* (1)
  {
    code: 'rbac.config.reload',
    module: 'rbac',
    action: 'reload',
    resourceType: 'config',
    description: '触发 RBAC 缓存失效',
  },
];

// P0-F PR-2A(2026-05-18):配置类接口 RBAC 接入第一批(19 条)。
// 沿评审稿 [`docs/first-release-p0f-pr2-config-rbac-review.md`](../docs/first-release-p0f-pr2-config-rbac-review.md)
// §4.2 + 用户拍板 D1=A / D3=A / D4=A。
//
// **code 命名规则**:3 段 kebab-case `module.action.resource_type`;沿 D7-RBAC v1.2 正则
// `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`(3-4 段;PR-2A 全 3 段无 scope)。
//
// **D3=A**:dict.delete.type / dict.delete.item / org.delete.node 放宽给 ops-admin
// (v1 原 @Roles(SUPER_ADMIN) 单角色;sub-protection 仍在 service 内:DICT_TYPE_IN_USE /
// ORGANIZATION_HAS_CHILDREN / LAST_ROOT_ORGANIZATION_PROTECTED 等不变)。
//
// **D4=A**:member-department 采用 set.current / clear.current 自定义动词
// (沿 PR-1 rbac.config.reload 范式;业务语义清晰优先)。

// dict.* 8 条(dict_types 4 + dict_items 4)
const DICT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'dict.read.type',
    module: 'dict',
    action: 'read',
    resourceType: 'type',
    description: '查看字典类型(列表 / 详情)',
  },
  {
    code: 'dict.create.type',
    module: 'dict',
    action: 'create',
    resourceType: 'type',
    description: '创建字典类型',
  },
  {
    code: 'dict.update.type',
    module: 'dict',
    action: 'update',
    resourceType: 'type',
    description: '更新字典类型(含启停)',
  },
  {
    code: 'dict.delete.type',
    module: 'dict',
    action: 'delete',
    resourceType: 'type',
    description: '软删字典类型(D3=A 放宽至 ops-admin)',
  },
  {
    code: 'dict.read.item',
    module: 'dict',
    action: 'read',
    resourceType: 'item',
    description: '查看字典项(列表 / 树形 / 详情)',
  },
  {
    code: 'dict.create.item',
    module: 'dict',
    action: 'create',
    resourceType: 'item',
    description: '创建字典项',
  },
  {
    code: 'dict.update.item',
    module: 'dict',
    action: 'update',
    resourceType: 'item',
    description: '更新字典项(含启停)',
  },
  {
    code: 'dict.delete.item',
    module: 'dict',
    action: 'delete',
    resourceType: 'item',
    description: '软删字典项(D3=A 放宽至 ops-admin)',
  },
];

// org.* 4 条(organizations R/C/U/D)
const ORG_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'org.read.node',
    module: 'org',
    action: 'read',
    resourceType: 'node',
    description: '查看组织节点(列表 / 树形 / 详情)',
  },
  {
    code: 'org.create.node',
    module: 'org',
    action: 'create',
    resourceType: 'node',
    description: '创建组织节点',
  },
  {
    code: 'org.update.node',
    module: 'org',
    action: 'update',
    resourceType: 'node',
    description: '更新组织节点(含启停)',
  },
  {
    code: 'org.delete.node',
    module: 'org',
    action: 'delete',
    resourceType: 'node',
    description: '软删组织节点(D3=A 放宽至 ops-admin)',
  },
];

// member-department.* 3 条(member-departments read / set / clear;D4=A)
const MEMBER_DEPARTMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member-department.read.current',
    module: 'member-department',
    action: 'read',
    resourceType: 'current',
    description: '查队员当前部门归属',
  },
  {
    code: 'member-department.set.current',
    module: 'member-department',
    action: 'set',
    resourceType: 'current',
    description: '幂等设置队员正式部门',
  },
  {
    code: 'member-department.clear.current',
    module: 'member-department',
    action: 'clear',
    resourceType: 'current',
    description: '解除队员当前部门归属',
  },
];

// contribution.* 4 条(contribution-rules R/C/U/D)
const CONTRIBUTION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'contribution.read.rule',
    module: 'contribution',
    action: 'read',
    resourceType: 'rule',
    description: '查看贡献值规则(列表 / 详情)',
  },
  {
    code: 'contribution.create.rule',
    module: 'contribution',
    action: 'create',
    resourceType: 'rule',
    description: '创建贡献值规则',
  },
  {
    code: 'contribution.update.rule',
    module: 'contribution',
    action: 'update',
    resourceType: 'rule',
    description: '更新贡献值规则',
  },
  {
    code: 'contribution.delete.rule',
    module: 'contribution',
    action: 'delete',
    resourceType: 'rule',
    description: '软删贡献值规则',
  },
];

// PR-2A 聚合(19 条:dict 8 + org 4 + member-department 3 + contribution 4)
const PR_2A_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...DICT_PERMISSION_SEED,
  ...ORG_PERMISSION_SEED,
  ...MEMBER_DEPARTMENT_PERMISSION_SEED,
  ...CONTRIBUTION_PERMISSION_SEED,
];

// P0-F PR-2B(2026-05-18):配置类接口 RBAC 接入第二批(15 条)。
// 沿评审稿 [`docs/first-release-p0f-pr2-config-rbac-review.md`](../docs/first-release-p0f-pr2-config-rbac-review.md)
// §4.3 + 用户拍板 D1=A / D2=A。
//
// **code 命名规则**:3 段 kebab-case `module.action.resource_type`;沿 D7-RBAC v1.2 正则
// `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`(3-4 段;PR-2B 全 3 段无 scope)。
//
// **D2=A 凭证收紧**:`storage-setting.reset.credentials` 仅 SUPER_ADMIN 短路通过;
// 该 permission **加入 Permission 全集 upsert**(供未来真实需求触发解锁),
// 但**不绑** `ops-admin`(沿 §5.2 + §6.2 ops-admin 最终绑定矩阵)。

// attachment-config.* 12 条(type 4 + mime 4 + size-limit 4)
const ATTACHMENT_CONFIG_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'attachment-config.read.type',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'type',
    description: '查看附件类型配置(列表 / 详情)',
  },
  {
    code: 'attachment-config.create.type',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'type',
    description: '创建附件类型配置',
  },
  {
    code: 'attachment-config.update.type',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'type',
    description: '更新附件类型配置(含启停)',
  },
  {
    code: 'attachment-config.delete.type',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'type',
    description: '软删附件类型配置',
  },
  {
    code: 'attachment-config.read.mime',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'mime',
    description: '查看附件 MIME 配置(列表 / 详情)',
  },
  {
    code: 'attachment-config.create.mime',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'mime',
    description: '创建附件 MIME 配置',
  },
  {
    code: 'attachment-config.update.mime',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'mime',
    description: '更新附件 MIME 配置(含启停)',
  },
  {
    code: 'attachment-config.delete.mime',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'mime',
    description: '软删附件 MIME 配置',
  },
  {
    code: 'attachment-config.read.size-limit',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'size-limit',
    description: '查看附件尺寸限制配置(列表 / 详情)',
  },
  {
    code: 'attachment-config.create.size-limit',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'size-limit',
    description: '创建附件尺寸限制配置',
  },
  {
    code: 'attachment-config.update.size-limit',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'size-limit',
    description: '更新附件尺寸限制配置',
  },
  {
    code: 'attachment-config.delete.size-limit',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'size-limit',
    description: '软删附件尺寸限制配置',
  },
];

// storage-setting.* 3 条(read / update singleton + reset credentials)
const STORAGE_SETTING_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'storage-setting.read.singleton',
    module: 'storage-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 Storage Settings singleton row',
  },
  {
    code: 'storage-setting.update.singleton',
    module: 'storage-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新 Storage Settings(upsert;不含凭证)',
  },
  {
    code: 'storage-setting.reset.credentials',
    module: 'storage-setting',
    action: 'reset',
    resourceType: 'credentials',
    description: '重置 COS SecretId / SecretKey(D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
];

// PR-2B 聚合(15 条:attachment-config 12 + storage-setting 3)
// 注意:全部 15 条 upsert 进 Permission 表;但 ops-admin 仅绑 14 条
//(`storage-setting.reset.credentials` 沿 D2=A 跳过)。
const PR_2B_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...ATTACHMENT_CONFIG_PERMISSION_SEED,
  ...STORAGE_SETTING_PERMISSION_SEED,
];

// D2=A:`storage-setting.reset.credentials` 不绑 ops-admin(凭证仅 SUPER_ADMIN 短路)
const PR_2B_RESET_CREDENTIALS_CODE = 'storage-setting.reset.credentials';

// Permission 全集(用于 step 1 upsert;14 rbac.* + 19 PR-2A + 15 PR-2B = 48 条)
const ALL_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...RBAC_PERMISSION_SEED,
  ...PR_2A_PERMISSION_SEED,
  ...PR_2B_PERMISSION_SEED,
];

// ops-admin 完整绑定集合(14 rbac.* + 19 PR-2A + 14 PR-2B = 47 条;沿 D1=A)
// 注:`storage-setting.reset.credentials` 从 PR_2B_PERMISSION_SEED 过滤掉(沿 D2=A;§6.2)
const OPS_ADMIN_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...RBAC_PERMISSION_SEED,
  ...PR_2A_PERMISSION_SEED,
  ...PR_2B_PERMISSION_SEED.filter((p) => p.code !== PR_2B_RESET_CREDENTIALS_CODE),
];

// 运营管理员角色 code(沿 D7 §10.1 / §10.3 ops-admin 唯一公开 placeholder)
const OPS_ADMIN_ROLE_CODE = 'ops-admin';
const OPS_ADMIN_DISPLAY_NAME = '运营管理员';
const OPS_ADMIN_DESCRIPTION =
  'RBAC 自身配置 + 用户角色分配 + 配置类接口(PR-2A: dict / org / member-department / contribution-rule + PR-2B: attachment-config / storage-setting)的 meta 角色;14 rbac.* + 19 PR-2A + 14 PR-2B = 47 条权限点;凭证 reset 仅 SUPER_ADMIN';

// V2.x C-7 attachments 实施 PR #6a(2026-05-15):20 条 attachment.* 权限点全集
// (沿 D7-attachments v1.0 §6.1 + Q11 v1.0 锁清单 + 用户 PR #6a 拍板)。
//
// **code 格式**:沿 D7-RBAC v1.2 修订正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`
// (3-4 段;scope 可选;PR #70 实装);本表 4 段 16 条 + 3 段 4 条 = 20 条全部合法。
//
// **scope 语义**:`.self` / `.other` 后缀触发 RbacService.judge() 的 ownership 判定
// (`action.endsWith('.self')` 触发 `checkOwnership(user, resource)`);3 段 activity 无 scope。
//
// **不实装的项**(沿用户 PR #6a 拍板):
// - ADMIN 内置角色(Q12 v1.0 沿用挂起;不创建)
// - 自动给 user 绑定 member 角色(Q2 v1.0:仍走 POST /api/v2/users/:userId/roles 显式)
// - .other 给 member 角色(member 仅持 .self + activity.view)
// - activity.upload / .update / .delete 给 member 角色(member 仅 view activity)
const ATTACHMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  // ============ member 8 条(4 段) ============
  {
    code: 'attachment.upload.member.self',
    module: 'attachment',
    action: 'upload',
    resourceType: 'member',
    description: '上传本人的身份证类附件',
  },
  {
    code: 'attachment.upload.member.other',
    module: 'attachment',
    action: 'upload',
    resourceType: 'member',
    description: '上传他人的身份证类附件',
  },
  {
    code: 'attachment.view.member.self',
    module: 'attachment',
    action: 'view',
    resourceType: 'member',
    description: '查看本人身份证类附件',
  },
  {
    code: 'attachment.view.member.other',
    module: 'attachment',
    action: 'view',
    resourceType: 'member',
    description: '查看他人身份证类附件',
  },
  {
    code: 'attachment.update.member.self',
    module: 'attachment',
    action: 'update',
    resourceType: 'member',
    description: '更新本人身份证类附件元数据',
  },
  {
    code: 'attachment.update.member.other',
    module: 'attachment',
    action: 'update',
    resourceType: 'member',
    description: '更新他人身份证类附件元数据',
  },
  {
    code: 'attachment.delete.member.self',
    module: 'attachment',
    action: 'delete',
    resourceType: 'member',
    description: '删除本人身份证类附件',
  },
  {
    code: 'attachment.delete.member.other',
    module: 'attachment',
    action: 'delete',
    resourceType: 'member',
    description: '删除他人身份证类附件',
  },
  // ============ certificate 8 条(4 段) ============
  {
    code: 'attachment.upload.certificate.self',
    module: 'attachment',
    action: 'upload',
    resourceType: 'certificate',
    description: '上传本人的证书类附件',
  },
  {
    code: 'attachment.upload.certificate.other',
    module: 'attachment',
    action: 'upload',
    resourceType: 'certificate',
    description: '上传他人证书类附件',
  },
  {
    code: 'attachment.view.certificate.self',
    module: 'attachment',
    action: 'view',
    resourceType: 'certificate',
    description: '查看本人证书附件',
  },
  {
    code: 'attachment.view.certificate.other',
    module: 'attachment',
    action: 'view',
    resourceType: 'certificate',
    description: '查看他人证书附件',
  },
  {
    code: 'attachment.update.certificate.self',
    module: 'attachment',
    action: 'update',
    resourceType: 'certificate',
    description: '更新本人证书附件元数据',
  },
  {
    code: 'attachment.update.certificate.other',
    module: 'attachment',
    action: 'update',
    resourceType: 'certificate',
    description: '更新他人证书附件元数据',
  },
  {
    code: 'attachment.delete.certificate.self',
    module: 'attachment',
    action: 'delete',
    resourceType: 'certificate',
    description: '删除本人证书附件',
  },
  {
    code: 'attachment.delete.certificate.other',
    module: 'attachment',
    action: 'delete',
    resourceType: 'certificate',
    description: '删除他人证书附件',
  },
  // ============ activity 4 条(3 段;粗粒度,无 self/other;沿 D7 v1.0 Q10) ============
  {
    code: 'attachment.upload.activity',
    module: 'attachment',
    action: 'upload',
    resourceType: 'activity',
    description: '上传活动现场照 / 封面',
  },
  {
    code: 'attachment.view.activity',
    module: 'attachment',
    action: 'view',
    resourceType: 'activity',
    description: '查看活动现场照 / 封面',
  },
  {
    code: 'attachment.update.activity',
    module: 'attachment',
    action: 'update',
    resourceType: 'activity',
    description: '更新活动附件元数据',
  },
  {
    code: 'attachment.delete.activity',
    module: 'attachment',
    action: 'delete',
    resourceType: 'activity',
    description: '删除活动附件',
  },
];

// member 内置角色 placeholder(沿 D7-attachments v1.0 §10.1 / §6.1 + 用户 PR #6a Q1:hardcoded)
const MEMBER_ROLE_CODE = 'member';
const MEMBER_ROLE_DISPLAY_NAME = '队员(USER 内置;运营可重命名)';
const MEMBER_ROLE_DESCRIPTION = 'USER 内置角色 placeholder;持有本人附件权限与 activity.view 权限';

// member 角色持有的 9 条权限点 code(沿 D7-attachments v1.0 §6.1 + 用户 PR #6a 拍板):
// - 8 条 .self(member × 4 + certificate × 4)
// - 1 条 activity.view(粗粒度活动级 view;不含 upload/update/delete)
const MEMBER_ROLE_PERMISSION_CODES: ReadonlyArray<string> = [
  'attachment.upload.member.self',
  'attachment.view.member.self',
  'attachment.update.member.self',
  'attachment.delete.member.self',
  'attachment.upload.certificate.self',
  'attachment.view.certificate.self',
  'attachment.update.certificate.self',
  'attachment.delete.certificate.self',
  'attachment.view.activity',
];

// V2.x C-6 RBAC 实施 PR #8:RBAC seed/bootstrap 主函数。
// 沿 D7 v1.1 §10 + 用户拍板六项决策。
// 幂等性:全部 upsert(Permission.code / RbacRole.code / RolePermission 复合唯一键 /
// UserRole 复合唯一键),重复跑不重复创建。
async function seedRbac(prisma: PrismaClient): Promise<void> {
  // 1. upsert Permission 全集(14 rbac.* + 19 PR-2A + 15 PR-2B = 48 条;
  //    沿 D7 §10.2 + P0-F PR-2A 2026-05-18 + P0-F PR-2B 2026-05-18)
  //    全部 48 条都进 Permission 表(含 reset.credentials);ops-admin 仅绑 47 条(沿 D2=A)
  for (const perm of ALL_PERMISSION_SEED) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      // 已存在不覆盖 description / module / action / resourceType(防止运营运行时调整被 seed 回退;
      // 沿 V2 dictionaries seed 范式)
      update: {},
      create: {
        code: perm.code,
        module: perm.module,
        action: perm.action,
        resourceType: perm.resourceType,
        description: perm.description,
      },
    });
  }
  console.log(
    `[seed] RBAC + PR-2A + PR-2B permissions ensured (${RBAC_PERMISSION_SEED.length} rbac.* + ${PR_2A_PERMISSION_SEED.length} PR-2A + ${PR_2B_PERMISSION_SEED.length} PR-2B = ${ALL_PERMISSION_SEED.length} entries)`,
  );

  // 2. upsert ops-admin RbacRole(公开 seed 唯一角色;沿用户拍板方案 A)
  const opsAdminRole = await prisma.rbacRole.upsert({
    where: { code: OPS_ADMIN_ROLE_CODE },
    update: {},
    create: {
      code: OPS_ADMIN_ROLE_CODE,
      displayName: OPS_ADMIN_DISPLAY_NAME,
      description: OPS_ADMIN_DESCRIPTION,
    },
    select: { id: true, code: true },
  });
  console.log(`[seed] RBAC role '${opsAdminRole.code}' ensured`);

  // 3. upsert RolePermission 映射:ops-admin → 14 rbac.* + 19 PR-2A + 14 PR-2B = 47 条
  //    (沿 D7 §10.3 + P0-F PR-2A 2026-05-18 D1=A 全绑 + D3=A 软删放宽 + PR-2B D1=A + D2=A 凭证收紧)
  //    复合唯一键 roleId_permissionId(schema @@unique([roleId, permissionId]))
  //    OPS_ADMIN_PERMISSION_SEED 已在常量定义处过滤 `storage-setting.reset.credentials`(D2=A)
  const allPermissions = await prisma.permission.findMany({
    where: { code: { in: OPS_ADMIN_PERMISSION_SEED.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  for (const perm of allPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: opsAdminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: opsAdminRole.id, permissionId: perm.id },
    });
  }
  console.log(
    `[seed] RBAC role-permissions ensured ('${opsAdminRole.code}' ↔ ${allPermissions.length} permissions: rbac.* + PR-2A + PR-2B; '${PR_2B_RESET_CREDENTIALS_CODE}' skipped per D2=A)`,
  );

  // 4. bootstrap user_role(沿 D7 §10.4 + 用户拍板方案 A):
  //    - RBAC_INITIAL_OPS_ADMIN_USER_ID env 优先
  //    - 无 env 时 fallback 到现有 SUPER_ADMIN(seed 阶段刚创建的或已存在的)
  //    - upsert 复合唯一键 userId_roleId(schema @@unique([userId, roleId]))保证幂等
  const envOpsAdminId = (process.env.RBAC_INITIAL_OPS_ADMIN_USER_ID ?? '').trim();
  let targetUserId: string | null = null;
  let bootstrapSource: 'env' | 'fallback' | 'skipped' = 'skipped';

  if (envOpsAdminId !== '') {
    // env 路径:校验该 user 存在 + 未软删 + ACTIVE
    const user = await prisma.user.findFirst({
      where: { id: envOpsAdminId, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true, username: true },
    });
    if (!user) {
      throw new Error(
        `[seed] RBAC_INITIAL_OPS_ADMIN_USER_ID='${envOpsAdminId}' 指定的用户不存在 / 已禁用 / 已软删;` +
          'bootstrap 中止',
      );
    }
    targetUserId = user.id;
    bootstrapSource = 'env';
    console.log(
      `[seed] RBAC bootstrap target = ${user.username} (id=${user.id}, source=env RBAC_INITIAL_OPS_ADMIN_USER_ID)`,
    );
  } else {
    // fallback:第一个活跃 SUPER_ADMIN(沿 D7 §10.4;findFirst orderBy createdAt asc 保证可复现)
    const superAdmin = await prisma.user.findFirst({
      where: { role: Role.SUPER_ADMIN, deletedAt: null, status: UserStatus.ACTIVE },
      orderBy: { createdAt: 'asc' },
      select: { id: true, username: true },
    });
    if (superAdmin) {
      targetUserId = superAdmin.id;
      bootstrapSource = 'fallback';
      console.log(
        `[seed] RBAC bootstrap target = ${superAdmin.username} (id=${superAdmin.id}, source=SUPER_ADMIN fallback)`,
      );
    } else {
      console.log(
        '[seed] RBAC bootstrap: 无 RBAC_INITIAL_OPS_ADMIN_USER_ID 且未找到活跃 SUPER_ADMIN;' +
          '跳过 user_role 自动分配(强校验将检测最终状态)',
      );
    }
  }

  if (targetUserId) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: targetUserId, roleId: opsAdminRole.id } },
      update: {},
      create: { userId: targetUserId, roleId: opsAdminRole.id },
    });
  }

  // 5. 强校验(沿 D7 §10.4 + §6.3 最后一个 ops-admin 保护范式):
  //    seed 完成后 **至少 1 个活跃 user_role 持有 ops-admin**,否则 throw 退出。
  //    检查范围:user 活跃 + ops-admin 角色未软删(理论本 seed 刚 upsert 应满足,
  //    但若 fallback 路径没找到 SUPER_ADMIN 且无 env,此处会 throw — 这是设计预期)。
  const activeOpsAdminCount = await prisma.userRole.count({
    where: {
      role: { code: OPS_ADMIN_ROLE_CODE, deletedAt: null },
      user: { deletedAt: null, status: UserStatus.ACTIVE },
    },
  });
  if (activeOpsAdminCount < 1) {
    throw new Error(
      `[seed] RBAC bootstrap 强校验失败:活跃 ops-admin 持有者数 = ${activeOpsAdminCount},` +
        '系统必须至少保留 1 个活跃运营管理员(沿 D7 §10.4 + §6.3)。' +
        '请通过 RBAC_INITIAL_OPS_ADMIN_USER_ID env 指定首个 ops-admin,或确保 seed 先创建 SUPER_ADMIN。',
    );
  }
  console.log(
    `[seed] RBAC bootstrap done (source=${bootstrapSource}, active ops-admin holders=${activeOpsAdminCount})`,
  );
}

// V2.x C-7 attachments 实施 PR #6a(2026-05-15):attachment.* 权限点 + member 内置角色 seed。
// 沿 D7-attachments v1.0 §6.1 / §10.3 + 用户 PR #6a Q1-Q5 拍板。
//
// 顺序:
// 1. upsert 20 条 attachment.* Permission(沿 §6.1 表)
// 2. upsert `member` RbacRole(placeholder;沿 Q1:hardcoded)
// 3. upsert 9 条 RolePermission 映射(member → 8 条 .self + 1 条 activity.view;沿 Q5)
//
// **不做项**(沿 Q2 / Q5 v1.0 拍板):
// - **不**自动给任何 user 绑定 member 角色(Q2:仍走 POST /api/v2/users/:userId/roles 显式)
// - **不**给 member 角色分配任何 .other 权限点
// - **不**给 member 角色分配 activity.upload / .update / .delete
// - **不**实装 ADMIN 内置角色(Q12 沿用挂起)
//
// **幂等性**(沿 Q3):全部 upsert(Permission.code / RbacRole.code / RolePermission 复合唯一键),
// 连续跑两次数量稳定。
async function seedAttachmentPermissions(prisma: PrismaClient): Promise<void> {
  // 1. upsert 20 条 attachment.* Permission(沿 D7 §6.1)
  for (const perm of ATTACHMENT_PERMISSION_SEED) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      // 已存在不覆盖(防止运营运行时调整被 seed 回退;沿 seedRbac 范式)
      update: {},
      create: {
        code: perm.code,
        module: perm.module,
        action: perm.action,
        resourceType: perm.resourceType,
        description: perm.description,
      },
    });
  }
  console.log(
    `[seed] attachment permissions ensured (${ATTACHMENT_PERMISSION_SEED.length} entries)`,
  );

  // 2. upsert member RbacRole(placeholder;沿 D7 §10.1 + Q1 hardcoded)
  const memberRole = await prisma.rbacRole.upsert({
    where: { code: MEMBER_ROLE_CODE },
    update: {},
    create: {
      code: MEMBER_ROLE_CODE,
      displayName: MEMBER_ROLE_DISPLAY_NAME,
      description: MEMBER_ROLE_DESCRIPTION,
    },
    select: { id: true, code: true },
  });
  console.log(`[seed] RBAC role '${memberRole.code}' ensured`);

  // 3. upsert RolePermission 映射:member → 9 条(8 条 .self + activity.view;沿 Q5)
  //    复合唯一键 roleId_permissionId(schema @@unique([roleId, permissionId]))
  const memberPermissions = await prisma.permission.findMany({
    where: { code: { in: [...MEMBER_ROLE_PERMISSION_CODES] } },
    select: { id: true, code: true },
  });
  if (memberPermissions.length !== MEMBER_ROLE_PERMISSION_CODES.length) {
    throw new Error(
      `[seed] attachment seed 强校验失败:期望找到 ${MEMBER_ROLE_PERMISSION_CODES.length} 条 ` +
        `member 角色 Permission,实际查到 ${memberPermissions.length} 条;` +
        '可能 ATTACHMENT_PERMISSION_SEED 与 MEMBER_ROLE_PERMISSION_CODES 不同步',
    );
  }
  for (const perm of memberPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: memberRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: memberRole.id, permissionId: perm.id },
    });
  }
  console.log(
    `[seed] attachment role-permissions ensured ('${memberRole.code}' ↔ ${memberPermissions.length} attachment.* permissions)`,
  );
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

    // V2 第一阶段批次 3:activity_type 二级树字典(D11)
    await seedActivityTypeHierarchy(prisma);

    // V2.x C-6 RBAC 实施 PR #8(沿 D7 v1.1 §10):14 条 rbac.* + ops-admin + bootstrap
    await seedRbac(prisma);

    // V2.x C-7 attachments 实施 PR #6a(沿 D7-attachments v1.0 §6.1 / §10.3):
    //   20 条 attachment.* + member 内置角色 + 9 条 RolePermission 映射
    //   注:依赖 seedRbac 已完成(本函数自身只 upsert Permission / RbacRole / RolePermission,
    //   不依赖任何 ops-admin 状态;但放在 seedRbac 之后保持"先 RBAC meta 再业务权限点"语义顺序)
    await seedAttachmentPermissions(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
