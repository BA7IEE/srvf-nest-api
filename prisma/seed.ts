import { PolicyScopeMode, PositionCategory, PrismaClient, Role, UserStatus } from '@prisma/client';
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
// SUPER_ADMIN 处理之后追加字典 seed(完整清单见 V2_DICT_SEED + seedActivityTypeHierarchy)。
// - dict_types: node_type / member_grade / gender / ethnicity 等
// - R13 收窄(2026-06-21 goal「字典内置」,维护者拍板,公开仓库已知情;权威源
//   docs/V2红线与复活路径.md A-9):仅**真实成员 PII(姓名 / 身份证 / 手机号)+ 真实编号规则与
//   样例(memberNo)不进 git history**;非敏感分类字典取值(国标参照 + 队内级别名 / 活动类别等)
//   允许内置 seed。node_type 已内置真实分类(组织节点类别;2026-06-21 goal「组织树内置」),
//   并由 seedOrganizations 内置 SRVF 根 + 15 部门;work_nature 本次仍留占位。
// - upsert + update: {} 实现幂等,不覆盖运营运行时手动调整(真实 label 仅干净库首次 seed 生效)
//
// V2 第一阶段批次 1 追加(详见 docs:批次1_schema草案_member_profiles_emergency_contacts.md
// v1.0 冻结版 §12.1 + 决议表 Q-S04 / Q-S06):
// 必开 6 个字典 type:emergency_relation / gender / document_type / political_status /
// blood_type / work_nature。前 5 类已内置国标 / 队内真实值(2026-06-21 goal「字典内置」);
// work_nature 仍占位(本次未给值)。
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
//   运营计分配置由队部 / 运营后台 / 私有 seed 维护,非本 seed 职责。
// - activity_type / attendance_role 已内置队内真实分类(2026-06-21 goal「字典内置」;
//   R13 收窄后非敏感分类字典可内置;attendance_role 7 项闭集沿 D13 不变)。
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

// V2 字典 seed:R13 收窄后非敏感分类字典内置真实值(国标参照 + 队内分类);node_type / work_nature
// 仍占位。真实成员 PII / 真实 memberNo 规则与样例仍不进 git(R13 保留口径;权威源 V2红线 A-9)。
// - type code 用 snake_case,与字段名 organizations.nodeTypeCode / members.gradeCode 对齐
// - 本表 dict_items 全部 parentId = null(顶层);activity_type 二级树由 seedActivityTypeHierarchy 处理
const V2_DICT_SEED = [
  {
    // 组织节点类别(2026-06-21 goal「组织树内置」;R13 收窄后非敏感分类字典可内置真实值)。
    // 8 项真实分类替换原 demo-node-type-1/2 占位。**4 个 professional-* code 原样保留**——
    // 长期契约,team-join 模块常量 PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE 依赖其存在
    //(org SMRT→mountain / SWRT→water / SURT→urban / STRT→high);仅 label 可改。
    // 非专业队分类(headquarters / rescue-team / functional-dept / volunteer)纯显示用、
    // 运营后台可增改。seedOrganizations 据此把 16 个内置 org 挂到对应 nodeTypeCode。
    // 冻结评审稿 recruitment-phase3-review.md §4.4。
    type: { code: 'node_type', label: '组织节点类别', sortOrder: 0 },
    items: [
      { code: 'headquarters', label: '总部', sortOrder: 0 },
      { code: 'professional-mountain', label: '山地专业救援队', sortOrder: 1 },
      { code: 'professional-water', label: '水域专业救援队', sortOrder: 2 },
      { code: 'professional-urban', label: '城市专业救援队', sortOrder: 3 },
      { code: 'professional-high', label: '高空专业救援队', sortOrder: 4 },
      { code: 'rescue-team', label: '救援保障队', sortOrder: 5 },
      { code: 'functional-dept', label: '职能部门', sortOrder: 6 },
      { code: 'volunteer', label: '志愿者', sortOrder: 7 },
      // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §3.0.1/§8.3 R1):组 / 工作组节点类别。
      // 队/部/中心下级组挂此类型;筹备组**不新增 nodeType**,用 establishmentStatusCode='provisional' 表达。
      { code: 'group', label: '组 / 工作组', sortOrder: 8 },
    ],
  },
  {
    // 队内队员级别(2026-06-21 goal「字典内置」授权;R13 收窄后非敏感分类字典可内置真实值):
    // 9 项 = volunteer(志愿者)+ level-1~7(正式队员 1~7 级)+ reserve(后备队员)。
    // level-1~7 code **稳定不变**(长期契约;members.assertGradeCodeValid 依赖其存在 + ACTIVE;
    // team-join 一键入队写死 gradeCode='level-1',只改 label 不受影响);volunteer / reserve 为新增
    // 显式可选项(promote 仍写 gradeCode=null = 志愿者实际落库状态,volunteer 字典项供显示 /
    // 运营选择用,双表示是已知取舍,**不改 promote / team-join 代码**)。评审稿 E-J-6 / §3.4。
    type: { code: 'member_grade', label: '队员级别', sortOrder: 1 },
    items: [
      { code: 'volunteer', label: '志愿者', sortOrder: 0 },
      { code: 'level-1', label: '正式队员1级', sortOrder: 1 },
      { code: 'level-2', label: '正式队员2级', sortOrder: 2 },
      { code: 'level-3', label: '正式队员3级', sortOrder: 3 },
      { code: 'level-4', label: '正式队员4级', sortOrder: 4 },
      { code: 'level-5', label: '正式队员5级', sortOrder: 5 },
      { code: 'level-6', label: '正式队员6级', sortOrder: 6 },
      { code: 'level-7', label: '正式队员7级', sortOrder: 7 },
      { code: 'reserve', label: '后备队员', sortOrder: 8 },
    ],
  },
  // ===== V2 第一阶段批次 1 的 6 个字典 =====
  // emergency_relation / gender / document_type / political_status / blood_type 已内置国标真值
  // (2026-06-21 goal「字典内置」;R13 收窄后非敏感分类字典可内置真实值);work_nature 仍占位(本次未给值)。
  // 全部 code 用稳定英文 snake_case(长期契约,定后不改),label 中文;每类注释标注 GB 依据。
  {
    // 紧急联系人关系(非敏感分类标签)。
    type: { code: 'emergency_relation', label: '紧急联系人关系', sortOrder: 2 },
    items: [
      { code: 'family', label: '家人', sortOrder: 0 },
      { code: 'friend', label: '朋友', sortOrder: 1 },
      { code: 'spouse', label: '配偶', sortOrder: 2 },
      { code: 'parent', label: '父母', sortOrder: 3 },
      { code: 'child', label: '子女', sortOrder: 4 },
      { code: 'other', label: '其他', sortOrder: 5 },
    ],
  },
  {
    // 性别(GB/T 2261.1-2003 个人基本信息·性别代码:0 未知 / 1 男 / 2 女 / 9 未说明)。
    type: { code: 'gender', label: '性别', sortOrder: 3 },
    items: [
      { code: 'male', label: '男', sortOrder: 0 },
      { code: 'female', label: '女', sortOrder: 1 },
      { code: 'unknown', label: '未知的性别', sortOrder: 2 },
      { code: 'unspecified', label: '未说明的性别', sortOrder: 3 },
    ],
  },
  {
    // 证件类型(沿居民身份证 + 公安部出入境证件常用分类;非敏感分类标签)。
    type: { code: 'document_type', label: '证件类型', sortOrder: 4 },
    items: [
      { code: 'id_card', label: '居民身份证', sortOrder: 0 },
      { code: 'household_register', label: '居民户口簿', sortOrder: 1 },
      { code: 'passport', label: '护照', sortOrder: 2 },
      { code: 'military_id', label: '军官证 / 士兵证', sortOrder: 3 },
      { code: 'hk_macau_permit', label: '港澳居民来往内地通行证', sortOrder: 4 },
      { code: 'taiwan_permit', label: '台湾居民来往大陆通行证', sortOrder: 5 },
      { code: 'foreigner_permit', label: '外国人永久居留身份证', sortOrder: 6 },
      { code: 'other', label: '其他', sortOrder: 7 },
    ],
  },
  {
    // 政治面貌(GB/T 4762-1984 政治面貌代码,13 类)。
    type: { code: 'political_status', label: '政治面貌', sortOrder: 5 },
    items: [
      { code: 'ccp_member', label: '中共党员', sortOrder: 0 },
      { code: 'ccp_probationary_member', label: '中共预备党员', sortOrder: 1 },
      { code: 'cyl_member', label: '共青团员', sortOrder: 2 },
      { code: 'rcck_member', label: '民革党员', sortOrder: 3 },
      { code: 'cdl_member', label: '民盟盟员', sortOrder: 4 },
      { code: 'cndca_member', label: '民建会员', sortOrder: 5 },
      { code: 'cape_member', label: '民进会员', sortOrder: 6 },
      { code: 'cpwdp_member', label: '农工党党员', sortOrder: 7 },
      { code: 'cpp_member', label: '致公党党员', sortOrder: 8 },
      { code: 'js_member', label: '九三学社社员', sortOrder: 9 },
      { code: 'tdsl_member', label: '台盟盟员', sortOrder: 10 },
      { code: 'non_party', label: '无党派人士', sortOrder: 11 },
      { code: 'masses', label: '群众', sortOrder: 12 },
    ],
  },
  {
    // 血型(ABO 血型系统;Rh 阴阳性如需另立字典)。
    type: { code: 'blood_type', label: '血型', sortOrder: 6 },
    items: [
      { code: 'a', label: 'A 型', sortOrder: 0 },
      { code: 'b', label: 'B 型', sortOrder: 1 },
      { code: 'ab', label: 'AB 型', sortOrder: 2 },
      { code: 'o', label: 'O 型', sortOrder: 3 },
      { code: 'unknown', label: '未知', sortOrder: 4 },
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
  {
    type: { code: 'content_type', label: '内容类型', sortOrder: 17 },
    // CMS 内容类型(label 占位,待运营细化;评审稿 §7):公告 / 公示 / 简报 / 推文
    items: [
      { code: 'announcement', label: '公告', sortOrder: 0 },
      { code: 'publicity', label: '公示', sortOrder: 1 },
      { code: 'briefing', label: '简报', sortOrder: 2 },
      { code: 'post', label: '推文', sortOrder: 3 },
    ],
  },
  // ===== 2026-06-21 goal「字典内置」追加 3 个国标参照字典 =====
  // marital_status / education / ethnicity:R13 收窄后非敏感分类字典可内置真实值;
  // code 稳定英文 / 拼音 snake_case(长期契约,定后不改),label 中文;注释标注 GB 依据。
  {
    // 婚姻状况(GB/T 2261.2-2003 婚姻状况代码:10 未婚 / 20 已婚 / 30 丧偶 / 40 离婚 / 90 未说明)。
    type: { code: 'marital_status', label: '婚姻状况', sortOrder: 18 },
    items: [
      { code: 'unmarried', label: '未婚', sortOrder: 0 },
      { code: 'married', label: '已婚', sortOrder: 1 },
      { code: 'widowed', label: '丧偶', sortOrder: 2 },
      { code: 'divorced', label: '离婚', sortOrder: 3 },
      { code: 'unspecified', label: '未说明的婚姻状况', sortOrder: 4 },
    ],
  },
  {
    // 学历 / 文化程度(GB/T 4658-2006 学历代码,常用层级扁平化)。
    type: { code: 'education', label: '学历 / 文化程度', sortOrder: 19 },
    items: [
      { code: 'doctor', label: '博士研究生', sortOrder: 0 },
      { code: 'master', label: '硕士研究生', sortOrder: 1 },
      { code: 'bachelor', label: '大学本科', sortOrder: 2 },
      { code: 'college', label: '大学专科', sortOrder: 3 },
      { code: 'secondary_vocational', label: '中等职业教育', sortOrder: 4 },
      { code: 'senior_high', label: '普通高中', sortOrder: 5 },
      { code: 'junior_high', label: '初中', sortOrder: 6 },
      { code: 'primary', label: '小学', sortOrder: 7 },
      { code: 'other', label: '其他 / 未说明', sortOrder: 8 },
    ],
  },
  {
    // 民族(GB/T 3304-1991 中国各民族名称的罗马字母拼写法和代码;56 民族,code 用拼音罗马字母)。
    type: { code: 'ethnicity', label: '民族', sortOrder: 20 },
    items: [
      { code: 'han', label: '汉族', sortOrder: 0 },
      { code: 'mongol', label: '蒙古族', sortOrder: 1 },
      { code: 'hui', label: '回族', sortOrder: 2 },
      { code: 'zang', label: '藏族', sortOrder: 3 },
      { code: 'uygur', label: '维吾尔族', sortOrder: 4 },
      { code: 'miao', label: '苗族', sortOrder: 5 },
      { code: 'yi', label: '彝族', sortOrder: 6 },
      { code: 'zhuang', label: '壮族', sortOrder: 7 },
      { code: 'buyei', label: '布依族', sortOrder: 8 },
      { code: 'chosen', label: '朝鲜族', sortOrder: 9 },
      { code: 'man', label: '满族', sortOrder: 10 },
      { code: 'dong', label: '侗族', sortOrder: 11 },
      { code: 'yao', label: '瑶族', sortOrder: 12 },
      { code: 'bai', label: '白族', sortOrder: 13 },
      { code: 'tujia', label: '土家族', sortOrder: 14 },
      { code: 'hani', label: '哈尼族', sortOrder: 15 },
      { code: 'kazak', label: '哈萨克族', sortOrder: 16 },
      { code: 'dai', label: '傣族', sortOrder: 17 },
      { code: 'li', label: '黎族', sortOrder: 18 },
      { code: 'lisu', label: '傈僳族', sortOrder: 19 },
      { code: 'va', label: '佤族', sortOrder: 20 },
      { code: 'she', label: '畲族', sortOrder: 21 },
      { code: 'gaoshan', label: '高山族', sortOrder: 22 },
      { code: 'lahu', label: '拉祜族', sortOrder: 23 },
      { code: 'sui', label: '水族', sortOrder: 24 },
      { code: 'dongxiang', label: '东乡族', sortOrder: 25 },
      { code: 'naxi', label: '纳西族', sortOrder: 26 },
      { code: 'jingpo', label: '景颇族', sortOrder: 27 },
      { code: 'kirgiz', label: '柯尔克孜族', sortOrder: 28 },
      { code: 'tu', label: '土族', sortOrder: 29 },
      { code: 'daur', label: '达斡尔族', sortOrder: 30 },
      { code: 'mulao', label: '仫佬族', sortOrder: 31 },
      { code: 'qiang', label: '羌族', sortOrder: 32 },
      { code: 'blang', label: '布朗族', sortOrder: 33 },
      { code: 'salar', label: '撒拉族', sortOrder: 34 },
      { code: 'maonan', label: '毛南族', sortOrder: 35 },
      { code: 'gelao', label: '仡佬族', sortOrder: 36 },
      { code: 'xibe', label: '锡伯族', sortOrder: 37 },
      { code: 'achang', label: '阿昌族', sortOrder: 38 },
      { code: 'pumi', label: '普米族', sortOrder: 39 },
      { code: 'tajik', label: '塔吉克族', sortOrder: 40 },
      { code: 'nu', label: '怒族', sortOrder: 41 },
      { code: 'uzbek', label: '乌孜别克族', sortOrder: 42 },
      { code: 'russ', label: '俄罗斯族', sortOrder: 43 },
      { code: 'ewenki', label: '鄂温克族', sortOrder: 44 },
      { code: 'deang', label: '德昂族', sortOrder: 45 },
      { code: 'bonan', label: '保安族', sortOrder: 46 },
      { code: 'yugur', label: '裕固族', sortOrder: 47 },
      { code: 'gin', label: '京族', sortOrder: 48 },
      { code: 'tatar', label: '塔塔尔族', sortOrder: 49 },
      { code: 'derung', label: '独龙族', sortOrder: 50 },
      { code: 'oroqen', label: '鄂伦春族', sortOrder: 51 },
      { code: 'hezhen', label: '赫哲族', sortOrder: 52 },
      { code: 'monba', label: '门巴族', sortOrder: 53 },
      { code: 'lhoba', label: '珞巴族', sortOrder: 54 },
      { code: 'jino', label: '基诺族', sortOrder: 55 },
    ],
  },
  {
    // 加入来源(member_profiles.joinSourceCode;候选字典,无 FK = 自由串)。招新闭环优化 S5
    //(2026-06-24,评审稿 §5 + §1.2 亲核纠正 8):promote 直写 joinSourceCode='recruitment',此前该字典
    // 从未 seed(自由串残留)。本片 additive 补齐字典基线(0 schema 改动、upsert 幂等),供后台展示/校验
    // 候选;镜像 phase-2 E-R2-15 遗留。未登记 dictionaries.service 防误删守卫(自由串候选字典,不在本片授权面)。
    type: { code: 'join_source', label: '加入来源', sortOrder: 21 },
    items: [{ code: 'recruitment', label: '招新转入', sortOrder: 0 }],
  },
  {
    // 统一通知模块 S1 站内信渠道(2026-06-25;冻结评审稿
    // docs/archive/reviews/unified-notification-dispatcher-review.md §9.4 / member-notification-review.md §7):
    // notification.notificationTypeCode ∈ 本字典 ACTIVE item;label 占位待运营细化。
    // code 沿通知域 kebab-case 风格(对齐 schema channels=['in-app']);后续可按招新六触发 / 活动 / 考勤细化。
    type: { code: 'notification_type', label: '通知类型', sortOrder: 22 },
    items: [
      { code: 'activity-reminder', label: '活动提醒', sortOrder: 0 },
      { code: 'recruitment', label: '招新公告', sortOrder: 1 },
      { code: 'emergency', label: '紧急召集', sortOrder: 2 },
      { code: 'general', label: '一般通知', sortOrder: 3 },
    ],
  },
  {
    // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §3.0.1 R1 / §8.3):组织设立状态。
    // 闭集:空 / formal=正式;provisional=筹备组(潜水组 / 炊事保障组（筹）)。转正 = 翻 provisional→formal,
    // 免改 nodeType、保任命与历史。Organization.establishmentStatusCode 引用本字典 code(v1 schema-only)。
    // 防误删守卫:闭集 → 已登记 dictionaries.service.ts SYSTEM + ITEM_PROTECTED_DICT_TYPES。
    type: { code: 'org_establishment_status', label: '组织设立状态', sortOrder: 23 },
    items: [
      { code: 'formal', label: '正式', sortOrder: 0 },
      { code: 'provisional', label: '筹备', sortOrder: 1 },
    ],
  },
  {
    // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §3.0.1 R3 / §8.3):组功能留口字典。
    // v1 只占字典类型 + Organization.groupFunctionCode 列位,**不写业务逻辑、items 留空**;未来按组功能
    //(训练 / 装备 / 文书 / 外展 / 无人机…)差异化职务规则再启用。自由串候选字典(groupFunctionCode 无 FK、
    // 无校验路径)→ 沿 join_source 惯例**不登记**防误删守卫(留口可不保护;goal DoD3)。
    type: { code: 'group_function', label: '组功能', sortOrder: 24 },
    items: [],
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

    console.log(`[seed] V2 dict '${entry.type.code}' ensured (${entry.items.length} items)`);
  }
}

// V2 第一阶段批次 3:activity_type 二级树字典(D11 / Q-S17;允许挂顶级父项)。
// 由于父子项需要 parentId 引用,无法走 V2_DICT_SEED 单层 upsert;独立函数处理:
// ① upsert dict_type 取 id
// ② upsert 父项取 id(parentMap 缓存)
// ③ upsert 子项,parentId 从 parentMap 取
// 幂等性:upsert + update: {} 保证;父子项顺序由本函数控制(先父后子)。
//
// 真实业务取值(2026-06-21 goal「字典内置」;R13 收窄后非敏感分类字典可内置真实值):
// - 9 父项 + 31 子项(队内真实活动分类);code 按中文生成稳定 snake_case(长期契约,定后不改),
//   label 中文。
// - 2026-06-21 维护者微调 4 处(pre-prod 无活动数据引用旧 code):救援 +「集结未行动」/ 物资 + 3 子
//   (日常 / 赛事保障 / 救援救灾物资)/ 轮值 icc_duty 合并「ICC轮值、无人机小组轮值」并删 uav_group_duty /
//   训练「内训需求训练」→「无贡献值训练」(code internal_demand_training → no_contribution_training,
//   语义变更故同步改 code)。
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
    { code: 'rescue', label: '救援', sortOrder: 0 },
    { code: 'support', label: '保障', sortOrder: 1 },
    { code: 'outreach', label: '外展活动', sortOrder: 2 },
    { code: 'training', label: '训练', sortOrder: 3 },
    { code: 'exchange', label: '交流', sortOrder: 4 },
    { code: 'joint_drill', label: '联合演练', sortOrder: 5 },
    { code: 'duty_rotation', label: '轮值', sortOrder: 6 },
    { code: 'logistics', label: '物资', sortOrder: 7 },
    { code: 'other', label: '其他', sortOrder: 8 },
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
    // 救援
    { code: 'rescue_mission', label: '救援', sortOrder: 0, parentCode: 'rescue' },
    { code: 'disaster_relief', label: '救灾', sortOrder: 1, parentCode: 'rescue' },
    { code: 'assistance', label: '救助', sortOrder: 2, parentCode: 'rescue' },
    { code: 'assembled_no_action', label: '集结未行动', sortOrder: 3, parentCode: 'rescue' },
    // 保障
    { code: 'event_support', label: '赛事保障', sortOrder: 0, parentCode: 'support' },
    { code: 'team_activity_support', label: '队伍活动保障', sortOrder: 1, parentCode: 'support' },
    // 外展活动
    { code: 'external_lecture', label: '对外讲座', sortOrder: 0, parentCode: 'outreach' },
    {
      code: 'external_promotion_federation',
      label: '对外宣导(联合会)',
      sortOrder: 1,
      parentCode: 'outreach',
    },
    { code: 'external_training', label: '对外培训', sortOrder: 2, parentCode: 'outreach' },
    {
      code: 'external_promotion_department',
      label: '对外宣导(部门)',
      sortOrder: 3,
      parentCode: 'outreach',
    },
    // 训练
    { code: 'team_training', label: '队伍训练', sortOrder: 0, parentCode: 'training' },
    { code: 'external_course', label: '外部培训', sortOrder: 1, parentCode: 'training' },
    {
      code: 'no_contribution_training',
      label: '无贡献值训练',
      sortOrder: 2,
      parentCode: 'training',
    },
    // 交流
    { code: 'competition_exchange', label: '赛事比武交流', sortOrder: 0, parentCode: 'exchange' },
    { code: 'key_meeting', label: '重要会议', sortOrder: 1, parentCode: 'exchange' },
    // 联合演练
    {
      code: 'external_joint_drill',
      label: '外单位联合演练',
      sortOrder: 0,
      parentCode: 'joint_drill',
    },
    {
      code: 'internal_multi_dept_drill',
      label: '内部三个部门以上联合演练',
      sortOrder: 1,
      parentCode: 'joint_drill',
    },
    // 轮值(icc_duty 合并「ICC轮值、无人机小组轮值」;原 uav_group_duty 删除)
    { code: 'futian_ustation', label: '福田 u 站', sortOrder: 0, parentCode: 'duty_rotation' },
    { code: 'wutongshan_duty', label: '梧桐山轮值', sortOrder: 1, parentCode: 'duty_rotation' },
    {
      code: 'icc_duty',
      label: 'ICC轮值、无人机小组轮值',
      sortOrder: 2,
      parentCode: 'duty_rotation',
    },
    { code: 'helicopter_duty', label: '直升机轮值', sortOrder: 3, parentCode: 'duty_rotation' },
    { code: 'department_duty', label: '部门轮值', sortOrder: 4, parentCode: 'duty_rotation' },
    // 物资
    { code: 'daily_supplies', label: '日常物资', sortOrder: 0, parentCode: 'logistics' },
    {
      code: 'event_support_supplies',
      label: '赛事保障物资',
      sortOrder: 1,
      parentCode: 'logistics',
    },
    {
      code: 'rescue_relief_supplies',
      label: '救援救灾物资',
      sortOrder: 2,
      parentCode: 'logistics',
    },
    // 其他
    { code: 'interview', label: '采访', sortOrder: 0, parentCode: 'other' },
    { code: 'general_meeting', label: '一般会议', sortOrder: 1, parentCode: 'other' },
    {
      code: 'psychological_assessment',
      label: '心理评估',
      sortOrder: 2,
      parentCode: 'other',
    },
    { code: 'department_team_building', label: '部门团建', sortOrder: 3, parentCode: 'other' },
    { code: 'transportation', label: '交通类', sortOrder: 4, parentCode: 'other' },
    { code: 'special_social_service', label: '特殊社会服务', sortOrder: 5, parentCode: 'other' },
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
    `[seed] V2 dict 'activity_type' ensured (${parents.length} 父项 + ${children.length} 子项,二级树)`,
  );
}

// 招新闭环优化 S1(2026-06-24 goal「招新闭环优化 S1」;评审稿 §4 状态业务化 §4.1/§4.2):
// recruitment_stage 字典 —— 招新业务态 stage → 展示文案(stageText)。后端只管 statusCode(机器态)
// + 派生 stage,展示文案落字典(后台可维护,改文案不发版);见 src/.../recruitment-progress-presenter.ts。
// S1 seed 现有持久数据可派生的 7 态;招新闭环优化 S4b(2026-06-24)补会话态/风险态 3 态(评审稿 §4.2):
// retake「待重拍」/ confirm「待核对」(报名记录尚未创建的会话态,submit 延迟响应派生)+
// manual_high(riskLevel=high)——**申请人侧文案中性「待人工核验」**(同 manual;高风险分级仅后台队列用,
// 不对申请人暴露疑似造假已被标记;goal 三③隐私口径)。
// **禁「已晋升」**(Q-P4-8):promoted 展示一律「已转志愿者 / 待入队」。
// 幂等:upsert by (typeId, code),update:{} 不回退运营调整(label/sortOrder/status 运营可后台改);二跑无漂移。
// 防误删守卫:dict_type + items 已登记 src/.../dictionaries.service.ts 的 SYSTEM/ITEM_PROTECTED_DICT_TYPES。
const RECRUITMENT_STAGE_SEED = [
  { code: 'manual', label: '待人工核验', sortOrder: 0 },
  { code: 'threshold', label: '门槛未完成', sortOrder: 1 },
  { code: 'threshold_done', label: '门槛已完成', sortOrder: 2 },
  { code: 'evaluation', label: '待综合评定', sortOrder: 3 },
  { code: 'publicity', label: '公示中', sortOrder: 4 },
  { code: 'volunteer', label: '已转志愿者 / 待入队', sortOrder: 5 },
  { code: 'rejected', label: '未通过', sortOrder: 6 },
  // S4b 会话态/风险态(评审稿 §4.2):
  { code: 'retake', label: '待重拍', sortOrder: 7 },
  { code: 'confirm', label: '待核对', sortOrder: 8 },
  { code: 'manual_high', label: '待人工核验', sortOrder: 9 }, // 申请人侧中性,等同 manual;高风险分流仅后台
] as const;

async function seedRecruitmentStageDict(prisma: PrismaClient): Promise<void> {
  const dictType = await prisma.dictType.upsert({
    where: { code: 'recruitment_stage' },
    update: {},
    create: { code: 'recruitment_stage', label: '招新进度态', sortOrder: 12 },
    select: { id: true },
  });

  for (const item of RECRUITMENT_STAGE_SEED) {
    await prisma.dictItem.upsert({
      where: { typeId_code: { typeId: dictType.id, code: item.code } },
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
    `[seed] V2 dict 'recruitment_stage' ensured (${RECRUITMENT_STAGE_SEED.length} items;招新业务态文案)`,
  );
}

// 组织树内置(2026-06-21 goal「组织树内置」;R13 收窄后非敏感组织名可内置真实值)。
// 扁平两层:1 个根(深圳公益救援队 / SRVF)+ 15 个部门(含 THQ 联合会)全部直挂其下;
// 日后要加中间层级另起 goal。镜像 seedActivityTypeHierarchy:先 upsert 根取 id,再 upsert 子
//(parentId = 根 id)。upsert by code(Organization.code @unique);update: {} 幂等,不覆盖
// 运营运行时调整(真实 name / nodeTypeCode 仅干净库首次 seed 生效)。
// 4 专业队 nodeTypeCode 必须挂对应 professional-*(team-join 门槛兼容,见 V2_DICT_SEED node_type)。
async function seedOrganizations(prisma: PrismaClient): Promise<void> {
  const root = await prisma.organization.upsert({
    where: { code: 'SRVF' },
    update: {},
    create: {
      name: '深圳公益救援队',
      code: 'SRVF',
      nodeTypeCode: 'headquarters',
      // parentId 默认 null = 根节点
    },
    select: { id: true },
  });

  // 15 个部门全部 parentId = 根。code 稳定(长期契约,定后不改);name / nodeTypeCode 运营可改。
  const departments = [
    { name: '山地救援队', code: 'SMRT', nodeTypeCode: 'professional-mountain', sortOrder: 0 },
    { name: '水上搜救队', code: 'SWRT', nodeTypeCode: 'professional-water', sortOrder: 1 },
    { name: '城市搜救队', code: 'SURT', nodeTypeCode: 'professional-urban', sortOrder: 2 },
    { name: '高空救援队', code: 'STRT', nodeTypeCode: 'professional-high', sortOrder: 3 },
    { name: '医疗辅助队', code: 'SAMT', nodeTypeCode: 'rescue-team', sortOrder: 4 },
    { name: '应急通讯队', code: 'SECT', nodeTypeCode: 'rescue-team', sortOrder: 5 },
    { name: '特勤部', code: 'SSD', nodeTypeCode: 'rescue-team', sortOrder: 6 },
    { name: '少辅队', code: 'STAT', nodeTypeCode: 'rescue-team', sortOrder: 7 },
    { name: '信息指挥中心', code: 'ICC', nodeTypeCode: 'functional-dept', sortOrder: 8 },
    { name: '志愿者组织部', code: 'VOD', nodeTypeCode: 'functional-dept', sortOrder: 9 },
    { name: '行政外联部', code: 'APD', nodeTypeCode: 'functional-dept', sortOrder: 10 },
    { name: '技术培训部', code: 'TTD', nodeTypeCode: 'functional-dept', sortOrder: 11 },
    { name: '秘书处', code: 'SEC', nodeTypeCode: 'functional-dept', sortOrder: 12 },
    { name: '联合会', code: 'THQ', nodeTypeCode: 'functional-dept', sortOrder: 13 },
    { name: '志愿者', code: 'VOL', nodeTypeCode: 'volunteer', sortOrder: 14 },
  ];

  const deptIds: string[] = [];
  for (const d of departments) {
    const dept = await prisma.organization.upsert({
      where: { code: d.code },
      update: {},
      create: {
        name: d.name,
        code: d.code,
        nodeTypeCode: d.nodeTypeCode,
        parentId: root.id,
        sortOrder: d.sortOrder,
      },
      select: { id: true },
    });
    deptIds.push(dept.id);
  }

  // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §3.8/§8.3):幂等补齐内置 16 节点 closure。
  // 全新库 migration 先于 seed 跑(Organization 空)→ WITH RECURSIVE backfill 插 0 行;此处按扁平两层
  // 结构补齐 31 行(16 自身 depth-0 + 15 根→子 depth-1),与 service create/move 事务内维护、与生产库
  //(节点先存在)migration 回填结果同构。upsert by 复合 PK,二跑 diff 空。
  const closureRows: Array<{ ancestorId: string; descendantId: string; depth: number }> = [
    { ancestorId: root.id, descendantId: root.id, depth: 0 }, // 根自身 depth-0
    ...deptIds.map((id) => ({ ancestorId: id, descendantId: id, depth: 0 })), // 15 子自身 depth-0
    ...deptIds.map((id) => ({ ancestorId: root.id, descendantId: id, depth: 1 })), // 根→15 子 depth-1
  ];
  for (const row of closureRows) {
    await prisma.organizationClosure.upsert({
      where: {
        ancestorId_descendantId: { ancestorId: row.ancestorId, descendantId: row.descendantId },
      },
      update: {},
      create: row,
    });
  }

  console.log(
    `[seed] organizations ensured (1 根 SRVF + ${departments.length} 部门,扁平两层;closure ${closureRows.length} 行)`,
  );
}

// 终态 scoped-authz PR3「职务定义」(2026-07-01 goal;冻结稿 §3.2 / §7.2 / R4 / §12)。
// 目录 v1 收敛为 6 领导职务(R4;PositionCategory.STAFF 干事留口不 seed —— 2026 公告里
// "文书 / 装备 / 训练"是组〔Organization〕而非个人职务,人是该组组长)。
// rank 按资历权重(正职 < 副职 < 组长 < 副组长;数值越小越资深,goal 定);allowMultiple 按 §12 公告实况:
//   队长 / 部长 = false(一组织一正职);副队长 / 副部长 / 组长 / 副组长 = true
//   (总队 6 副队长;SURT 训练组多组长);allowConcurrent 全 true(赵强兼 SAMT 队长)。
// 幂等 upsert by code;update:{} 不覆盖运营运行时调整(真实值仅干净库首次 seed 生效)。
// **本表纯配置定义,绝不被任何判权路径读**(消费它的 policy=PR7 / assignment=PR4 / authz=PR8)。
const POSITION_SEED: ReadonlyArray<{
  code: string;
  name: string;
  categoryCode: PositionCategory;
  rank: number;
  isLeadership: boolean;
  allowMultiple: boolean;
  allowConcurrent: boolean;
  sortOrder: number;
  description: string;
}> = [
  {
    code: 'team-leader',
    name: '队长',
    categoryCode: PositionCategory.LEADER,
    rank: 10,
    isLeadership: true,
    allowMultiple: false,
    allowConcurrent: true,
    sortOrder: 1,
    description: '队 / 中心正职负责人(一组织一正职)',
  },
  {
    code: 'vice-captain',
    name: '副队长',
    categoryCode: PositionCategory.DEPUTY,
    rank: 20,
    isLeadership: true,
    allowMultiple: true,
    allowConcurrent: true,
    sortOrder: 2,
    description: '队 / 中心副职负责人(可多人,如总队 6 副队长)',
  },
  {
    code: 'dept-leader',
    name: '部长',
    categoryCode: PositionCategory.LEADER,
    rank: 10,
    isLeadership: true,
    allowMultiple: false,
    allowConcurrent: true,
    sortOrder: 3,
    description: '部门正职负责人(一组织一正职)',
  },
  {
    code: 'dept-deputy',
    name: '副部长',
    categoryCode: PositionCategory.DEPUTY,
    rank: 20,
    isLeadership: true,
    allowMultiple: true,
    allowConcurrent: true,
    sortOrder: 4,
    description: '部门副职负责人(可多人)',
  },
  {
    code: 'group-leader',
    name: '组长',
    categoryCode: PositionCategory.LEADER,
    rank: 30,
    isLeadership: true,
    allowMultiple: true,
    allowConcurrent: true,
    sortOrder: 5,
    description: '组正职负责人(可多人,如 SURT 训练组多组长)',
  },
  {
    code: 'deputy-group-leader',
    name: '副组长',
    categoryCode: PositionCategory.DEPUTY,
    rank: 40,
    isLeadership: true,
    allowMultiple: true,
    allowConcurrent: true,
    sortOrder: 6,
    description: '组副职负责人(可多人)',
  },
];

// 默认职务规则(冻结稿 §2.2 + R6 + R8;30 条 = 2 + 4×4 + 6 + 4 + 2)。按"组织类别(node_type)"声明。
// R6 一类多领导称谓:rescue-team 同时登记队长 / 副队长 + 部长 / 副部长(SAMT/SECT/SSD 用队长、
//   STAT 用部长,两套都登记由实际任命择一)。
// R8 requireMembership 按 (nodeType, position) 可配:仅总队级领导(headquarters 队长 / 副队长)
//   = false(总队长 / 副队长其 PRIMARY 归属在本队,不必"归属"于根);其余全 true
//   (组长 / 副组长应在本组织子树内有 active 归属;goal DoD)。→ requireMembership = nodeType !== 'headquarters'。
// volunteer(VOL 持有桶)不设任何职务规则。
// required / allowConcurrent / status / minCount / maxCount 走列默认(false / true / ACTIVE / null / null;
// minCount/maxCount 留空,runner 定)。幂等 upsert by (nodeTypeCode, positionId);update:{} 不覆盖运营调整。
const POSITION_RULE_SEED: ReadonlyArray<{
  nodeTypeCode: string;
  positionCodes: readonly string[];
}> = [
  { nodeTypeCode: 'headquarters', positionCodes: ['team-leader', 'vice-captain'] },
  {
    nodeTypeCode: 'professional-mountain',
    positionCodes: ['team-leader', 'vice-captain', 'group-leader', 'deputy-group-leader'],
  },
  {
    nodeTypeCode: 'professional-water',
    positionCodes: ['team-leader', 'vice-captain', 'group-leader', 'deputy-group-leader'],
  },
  {
    nodeTypeCode: 'professional-urban',
    positionCodes: ['team-leader', 'vice-captain', 'group-leader', 'deputy-group-leader'],
  },
  {
    nodeTypeCode: 'professional-high',
    positionCodes: ['team-leader', 'vice-captain', 'group-leader', 'deputy-group-leader'],
  },
  {
    // R6:队长 / 副队长(SAMT/SECT/SSD)+ 部长 / 副部长(STAT)两套领导称谓都登记,任命择一。
    nodeTypeCode: 'rescue-team',
    positionCodes: [
      'team-leader',
      'vice-captain',
      'dept-leader',
      'dept-deputy',
      'group-leader',
      'deputy-group-leader',
    ],
  },
  {
    nodeTypeCode: 'functional-dept',
    positionCodes: ['dept-leader', 'dept-deputy', 'group-leader', 'deputy-group-leader'],
  },
  { nodeTypeCode: 'group', positionCodes: ['group-leader', 'deputy-group-leader'] },
  // volunteer → 无规则(VOL 持有桶)
];

async function seedPositions(prisma: PrismaClient): Promise<void> {
  for (const p of POSITION_SEED) {
    await prisma.organizationPosition.upsert({
      where: { code: p.code },
      update: {},
      create: {
        code: p.code,
        name: p.name,
        categoryCode: p.categoryCode,
        rank: p.rank,
        isLeadership: p.isLeadership,
        allowMultiple: p.allowMultiple,
        allowConcurrent: p.allowConcurrent,
        sortOrder: p.sortOrder,
        description: p.description,
      },
    });
  }
  console.log(
    `[seed] organization positions ensured (${POSITION_SEED.length} 领导职务;R4 STAFF 干事留口不 seed)`,
  );
}

async function seedPositionRules(prisma: PrismaClient): Promise<void> {
  const positions = await prisma.organizationPosition.findMany({
    where: { code: { in: POSITION_SEED.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(positions.map((p) => [p.code, p.id]));

  let ruleCount = 0;
  for (const rule of POSITION_RULE_SEED) {
    // R8:仅总队级领导免根归属;其余(含组长 / 副组长)要求本组织子树内 active 归属。
    const requireMembership = rule.nodeTypeCode !== 'headquarters';
    for (const posCode of rule.positionCodes) {
      const positionId = idByCode.get(posCode);
      if (!positionId) {
        throw new Error(
          `[seed] position rule for nodeType '${rule.nodeTypeCode}' references unknown position code '${posCode}'`,
        );
      }
      await prisma.organizationPositionRule.upsert({
        where: {
          nodeTypeCode_positionId: { nodeTypeCode: rule.nodeTypeCode, positionId },
        },
        update: {},
        create: {
          nodeTypeCode: rule.nodeTypeCode,
          positionId,
          requireMembership,
          // required=false / allowConcurrent=true / status=ACTIVE / minCount=maxCount=null 走列默认
        },
      });
      ruleCount++;
    }
  }
  console.log(
    `[seed] organization position rules ensured (${ruleCount} 条默认规则;§2.2 + R6 一类多领导称谓 + R8 总队级免根归属)`,
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
  {
    // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §8.3/§11 PR1):reparent 重挂父级。
    // 沿 org.*.node 现绑(绑 ops-admin);service 层 rbac.can('org.move.node'),0 @Roles。
    code: 'org.move.node',
    module: 'org',
    action: 'move',
    resourceType: 'node',
    description: '重挂组织节点父级(reparent;环 / 受限位置守卫)',
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

// membership.* 4 条(终态 scoped-authz PR2;冻结稿 §4.3 / §7.1;member-department.* 的升级面,旧 3 码保留 deprecated)。
// 端点映射(§7.1):GET list→list / POST 新增+PATCH 改 共用 set / DELETE 结束→end。
// read.record 按 §4.3 seed 并绑 ops-admin(→168/68),本刀无端点承接(为未来 GET :id 预留)= 刻意预埋孤码
//(docs:rbacmap:check 记 WARN 不记 FAIL;不违反 DoD「0-FAIL」)。全 4 码绑 ops-admin(沿 member-department.* 现绑)。
const MEMBERSHIP_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'membership.list.record',
    module: 'membership',
    action: 'list',
    resourceType: 'record',
    description: '列出队员全部组织归属(主/兼/临时/支援 + 任期)',
  },
  {
    code: 'membership.read.record',
    module: 'membership',
    action: 'read',
    resourceType: 'record',
    description: '读取单条组织归属(预留;本刀无端点承接)',
  },
  {
    code: 'membership.set.record',
    module: 'membership',
    action: 'set',
    resourceType: 'record',
    description: '新增 / 修改组织归属(类型 / 任期)',
  },
  {
    code: 'membership.end.record',
    module: 'membership',
    action: 'end',
    resourceType: 'record',
    description: '结束组织归属',
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

// position.* 4 + position-rule.* 4(终态 scoped-authz PR3;冻结稿 §4.3 / §7.2;职务定义 + 职务规则
// 纯配置面 CRUD;沿 dict / org / contribution 配置码现绑 ops-admin)。**Position/Rule 绝不进判权路径**。
const POSITION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'position.read.definition',
    module: 'position',
    action: 'read',
    resourceType: 'definition',
    description: '查看职务定义(列表 / 详情)',
  },
  {
    code: 'position.create.definition',
    module: 'position',
    action: 'create',
    resourceType: 'definition',
    description: '创建职务定义',
  },
  {
    code: 'position.update.definition',
    module: 'position',
    action: 'update',
    resourceType: 'definition',
    description: '更新职务定义(含启停)',
  },
  {
    code: 'position.delete.definition',
    module: 'position',
    action: 'delete',
    resourceType: 'definition',
    description: '软删职务定义(被职务规则引用时禁删)',
  },
  {
    code: 'position-rule.read.record',
    module: 'position-rule',
    action: 'read',
    resourceType: 'record',
    description: '查看职务规则(按 nodeTypeCode 过滤)',
  },
  {
    code: 'position-rule.create.record',
    module: 'position-rule',
    action: 'create',
    resourceType: 'record',
    description: '创建职务规则(某类组织可设哪些职务)',
  },
  {
    code: 'position-rule.update.record',
    module: 'position-rule',
    action: 'update',
    resourceType: 'record',
    description: '更新职务规则(含启停)',
  },
  {
    code: 'position-rule.delete.record',
    module: 'position-rule',
    action: 'delete',
    resourceType: 'record',
    description: '软删职务规则',
  },
];

// position-assignment.* 4(终态 scoped-authz PR4「任职」;冻结稿 §4.3 / §7.3;任职管理 + 历史;
// 沿组织归属域配置/管理码现绑 ops-admin)。**任职 = 数据 + 任命校验,绝不进判权路径**(判权是 PR8)。
// 双轴读(组织轴列 + 队员轴列)共用 position-assignment.read.record;历史链单独 read.history。
const POSITION_ASSIGNMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'position-assignment.read.record',
    module: 'position-assignment',
    action: 'read',
    resourceType: 'record',
    description: '查看任职(组织轴在任列表 / 队员轴任职含历史)',
  },
  {
    code: 'position-assignment.create.record',
    module: 'position-assignment',
    action: 'create',
    resourceType: 'record',
    description: '任命(校验职务适配 / 单人独占 / 兼任 / 归属要求 / 任期)',
  },
  {
    code: 'position-assignment.revoke.record',
    module: 'position-assignment',
    action: 'revoke',
    resourceType: 'record',
    description: '撤销任职(status=REVOKED + 撤销人 + endedAt)',
  },
  {
    code: 'position-assignment.read.history',
    module: 'position-assignment',
    action: 'read',
    resourceType: 'history',
    description: '查看任职变更/历史链',
  },
];

// supervision-assignment.* 4(终态 scoped-authz PR5「分管」;冻结稿 §4.3 / §7.4;分管管理 + 分管范围/被谁分管查询;
// 沿组织归属域配置/管理码现绑 ops-admin)。**分管 = 数据 + 展示,绝不进判权路径**(判权是 PR8)。
// 三读端点(列 / 某人分管范围 / 某组织被谁分管)共用 supervision-assignment.read.record,无孤码。
const SUPERVISION_ASSIGNMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'supervision-assignment.read.record',
    module: 'supervision-assignment',
    action: 'read',
    resourceType: 'record',
    description: '查看分管(在任列表 / 某人分管范围 / 某组织被谁分管)',
  },
  {
    code: 'supervision-assignment.create.record',
    module: 'supervision-assignment',
    action: 'create',
    resourceType: 'record',
    description: '建分管(supervisor × org × scopeMode + 任期;与职务正交,不要求持职务)',
  },
  {
    code: 'supervision-assignment.update.record',
    module: 'supervision-assignment',
    action: 'update',
    resourceType: 'record',
    description: '改分管(scopeMode / 任期 / note)',
  },
  {
    code: 'supervision-assignment.revoke.record',
    module: 'supervision-assignment',
    action: 'revoke',
    resourceType: 'record',
    description: '撤销分管(status=REVOKED + 撤销人 + endedAt)',
  },
];

// role-binding.* 4(终态 scoped-authz PR6「RoleBinding」;冻结稿 §4.3 / §7.5;带 scope 的角色绑定管理面;
// 沿组织归属域配置/管理码现绑 ops-admin)。**scoped 绑定入库即止,RbacService 只读 GLOBAL、绝不判 scoped**(判权是 PR8)。
const ROLE_BINDING_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'role-binding.read.record',
    module: 'role-binding',
    action: 'read',
    resourceType: 'record',
    description: '查看角色绑定(principal × role × scope × 任期;含 scoped 各型)',
  },
  {
    code: 'role-binding.create.record',
    module: 'role-binding',
    action: 'create',
    resourceType: 'record',
    description:
      '建角色绑定(principal × role × scope + 任期;GLOBAL/ORGANIZATION/TREE/ACTIVITY/RESOURCE/SELF)',
  },
  {
    code: 'role-binding.update.record',
    module: 'role-binding',
    action: 'update',
    resourceType: 'record',
    description: '改角色绑定(任期 / 状态 / note)',
  },
  {
    code: 'role-binding.delete.record',
    module: 'role-binding',
    action: 'delete',
    resourceType: 'record',
    description: '软删角色绑定(status=ENDED + endedAt + deletedAt)',
  },
];

// PR-2A 聚合(44 条:dict 8 + org 5〔终态 scoped-authz PR1 +org.move.node〕+ member-department 3 +
// membership 4〔终态 scoped-authz PR2〕+ contribution 4 + position 4 + position-rule 4〔终态 scoped-authz PR3〕
// + position-assignment 4〔终态 scoped-authz PR4〕+ supervision-assignment 4〔终态 scoped-authz PR5〕
// + role-binding 4〔终态 scoped-authz PR6〕)。
// member-department 与 membership 同"组织归属"域,membership 为 member-department 的升级面(旧 3 码保留 deprecated);
// position / position-rule 为职务定义配置面;position-assignment 为任职管理面;supervision-assignment 为分管管理面;
// role-binding 为带 scope 的角色绑定管理面(scoped 入库即止,RbacService 只读 GLOBAL,判权是 PR8)
//(冻结稿 §4.3;全绑 ops-admin,沿配置/管理码现绑)。
const PR_2A_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...DICT_PERMISSION_SEED,
  ...ORG_PERMISSION_SEED,
  ...MEMBER_DEPARTMENT_PERMISSION_SEED,
  ...MEMBERSHIP_PERMISSION_SEED,
  ...CONTRIBUTION_PERMISSION_SEED,
  ...POSITION_PERMISSION_SEED,
  ...POSITION_ASSIGNMENT_PERMISSION_SEED,
  ...SUPERVISION_ASSIGNMENT_PERMISSION_SEED,
  ...ROLE_BINDING_PERMISSION_SEED,
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

// =========================================================================
// P0-F PR-3B(2026-05-18):users 模块 RBAC 接入新增 7 条 user.* permission。
// 沿评审稿 docs/first-release-p0f-pr3-users-rbac-review.md §4.2 + §6.2 + D1=A / D2=B / D3=A。
//
// 端点 → permission 映射(沿评审稿 §4 / §6 / §8):
//   GET    /api/users              → user.read.account
//   POST   /api/users              → user.create.account
//   GET    /api/users/:id          → user.read.account(list / findOne 共享)
//   PATCH  /api/users/:id          → user.update.account
//   PUT    /api/users/:id/password → user.reset.password
//   PATCH  /api/users/:id/role     → user.update.role(D1=A:不绑 ops-admin,仅 SA 短路)
//   PATCH  /api/users/:id/status   → user.update.status
//   DELETE /api/users/:id          → user.delete.account
//
// ops-admin 绑定(D1=A / D2=B / D3=A):6 条(过滤 user.update.role)。
// service 内 6 项业务护栏全保留:canViewUser / canManageUser / canCreateRole /
// canChangeRole / assertNotSelf / assertNotLastSuperAdmin(沿评审稿 §8.3)。
// =========================================================================

// D1=A:`user.update.role` 不绑 ops-admin(角色修改仅 SUPER_ADMIN 短路;
// service 层 canChangeRole 仍要求 actor=SA + 永禁升 SA)
const PR_3B_USER_UPDATE_ROLE_CODE = 'user.update.role';

const USER_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'user.read.account',
    module: 'user',
    action: 'read',
    resourceType: 'account',
    description: '查看用户列表与详情(list + findOne 共享;service 内 canViewUser 收窄范围)',
  },
  {
    code: 'user.create.account',
    module: 'user',
    action: 'create',
    resourceType: 'account',
    description: '创建用户(service 内 canCreateRole 永禁创建 SUPER_ADMIN)',
  },
  {
    code: 'user.update.account',
    module: 'user',
    action: 'update',
    resourceType: 'account',
    description: '修改用户资料(email / nickname / avatarKey;service 内 assertCanManageUser)',
  },
  {
    code: 'user.reset.password',
    module: 'user',
    action: 'reset',
    resourceType: 'password',
    description:
      '管理员重置用户密码(D2=B 绑 ops-admin;service 内 assertCanManageUser + 撤 refresh)',
  },
  {
    code: PR_3B_USER_UPDATE_ROLE_CODE,
    module: 'user',
    action: 'update',
    resourceType: 'role',
    description:
      '修改用户角色(D1=A:仅 SUPER_ADMIN 短路;不绑 ops-admin;service 内 canChangeRole 永禁升 SA + assertNotSelf + assertNotLastSuperAdmin)',
  },
  {
    code: 'user.update.status',
    module: 'user',
    action: 'update',
    resourceType: 'status',
    description:
      '启用 / 禁用用户(service 内 assertCanManageUser + assertNotSelf(DISABLED) + assertNotLastSuperAdmin + 撤 refresh)',
  },
  {
    code: 'user.delete.account',
    module: 'user',
    action: 'delete',
    resourceType: 'account',
    description:
      '软删除用户(service 内 assertNotSelf + assertCanManageUser + assertNotLastSuperAdmin + 撤 refresh)',
  },
];

// =========================================================================
// P0-F PR-4B(2026-05-18):audit-logs 模块 RBAC 接入新增 1 条 audit-log.* permission。
// 沿评审稿 docs/first-release-p0f-pr4-audit-logs-rbac-review.md §4.2 + §6.2 + D1=A / D2=B / D3=A / D4=A / D5=A。
//
// 端点 → permission 映射(沿评审稿 §4 / §7):
//   GET /api/v2/audit-logs        → audit-log.read.entry(list)
//   GET /api/v2/audit-logs/:id    → audit-log.read.entry(findOne;list / findOne 共享 read,D4=A)
//
// ops-admin 绑定(D2=B):整条加入,不过滤(沿评审稿 §5.2 推荐;数据范围 service 层兜底)。
// service 内现有数据范围 + assertCanReadAuditLog + 14101 越级码全部保留(沿评审稿 §8.3)。
// =========================================================================

const AUDIT_LOG_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'audit-log.read.entry',
    module: 'audit-log',
    action: 'read',
    resourceType: 'entry',
    description:
      '查看审计记录(list + findOne 共享;service 内 list ADMIN where 注入 + detail assertCanReadAuditLog + 14101 越级码全部保留)',
  },
];

// =========================================================================
// SMS 基础设施 T2(2026-06-10):+5 条权限码(76→81;冻结评审稿
// docs/archive/reviews/sms-verification-infra-review.md §3.4 / E-3)。
//
// 端点 → permission 映射(评审稿 §3.2):
//   GET    /api/system/v1/sms-settings                    → sms-setting.read.singleton
//   PATCH  /api/system/v1/sms-settings                    → sms-setting.update.singleton
//   POST   /api/system/v1/sms-settings/reset-credentials  → sms-setting.reset.credentials
//   GET    /api/system/v1/sms-send-logs                   → sms-send-log.read.list
//   DELETE /api/admin/v1/users/:id/phone(T3 实装)        → user.phone.clear
//
// ops-admin 绑定:4 条;`sms-setting.reset.credentials` **不绑**(镜像 storage D2=A,
// 仅 SUPER_ADMIN 短路)。`user.phone.clear` code 字符串按 goal 原文(module=user /
// action=clear / resourceType=phone 仅元数据描述);其端点 T3 落地,T2 期间为孤码
// (rbacmap 检查预期 WARN,非 FAIL)。
// =========================================================================

// 镜像 PR_2B_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
const SMS_RESET_CREDENTIALS_CODE = 'sms-setting.reset.credentials';

const SMS_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'sms-setting.read.singleton',
    module: 'sms-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 SMS Settings singleton row',
  },
  {
    code: 'sms-setting.update.singleton',
    module: 'sms-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新 SMS Settings(upsert;不含凭证;production-like 禁 DEV_STUB)',
  },
  {
    code: SMS_RESET_CREDENTIALS_CODE,
    module: 'sms-setting',
    action: 'reset',
    resourceType: 'credentials',
    description:
      '重置腾讯云 SMS SecretId / SecretKey(镜像 storage D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
  {
    code: 'sms-send-log.read.list',
    module: 'sms-send-log',
    action: 'read',
    resourceType: 'list',
    description: '分页查看短信发送日志(响应手机号一律掩码)',
  },
  {
    code: 'user.phone.clear',
    module: 'user',
    action: 'clear',
    resourceType: 'phone',
    description:
      '管理员清除用户绑定手机号(T3 实装端点;service 内 rbac.can + assertCanManageUser;幂等)',
  },
];

// =========================================================================
// 微信小程序登录 T2(2026-06-12):+4 条权限码(117→121;冻结评审稿
// docs/archive/reviews/wechat-mini-login-review.md §3.4 / E-22)。
//
// 端点 → permission 映射(评审稿 §3.2):
//   GET    /api/system/v1/wechat-settings                    → wechat-setting.read.singleton
//   PATCH  /api/system/v1/wechat-settings                    → wechat-setting.update.singleton
//   POST   /api/system/v1/wechat-settings/reset-credentials  → wechat-setting.reset.credentials
//   DELETE /api/admin/v1/users/:id/wechat(T3 实装)          → user.wechat.clear
//
// ops-admin 绑定:3 条;`wechat-setting.reset.credentials` **不绑**(镜像 storage/sms D2=A,
// 仅 SUPER_ADMIN 短路)。`user.wechat.clear` 端点 T3 落地,T2 期间为孤码
// (rbacmap 检查预期 WARN,非 FAIL;镜像 user.phone.clear 先例)。
// =========================================================================

// 镜像 SMS_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
const WECHAT_RESET_CREDENTIALS_CODE = 'wechat-setting.reset.credentials';

const WECHAT_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'wechat-setting.read.singleton',
    module: 'wechat-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 WeChat Settings singleton row',
  },
  {
    code: 'wechat-setting.update.singleton',
    module: 'wechat-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新 WeChat Settings(upsert;不含凭证;production-like 禁 DEV_STUB)',
  },
  {
    code: WECHAT_RESET_CREDENTIALS_CODE,
    module: 'wechat-setting',
    action: 'reset',
    resourceType: 'credentials',
    description: '重置微信小程序 AppSecret(镜像 storage/sms D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
  {
    code: 'user.wechat.clear',
    module: 'user',
    action: 'clear',
    resourceType: 'wechat',
    description:
      '管理员清除用户绑定微信 openid(T3 实装端点;service 内 rbac.can + assertCanManageUser;幂等)',
  },
];

// =========================================================================
// 招新一期 · 实名核验通道 T1(2026-06-18):+3 条 settings 权限码(冻结评审稿
// docs/archive/reviews/recruitment-phase1-review.md §3.4 / E-R-19)。
//
// 端点 → permission 映射(评审稿 §3.2;端点 T2 实装):
//   GET    /api/system/v1/realname-settings                    → realname-setting.read.singleton
//   PATCH  /api/system/v1/realname-settings                    → realname-setting.update.singleton
//   POST   /api/system/v1/realname-settings/reset-credentials  → realname-setting.reset.credentials
//
// ops-admin 绑定:2 条;`realname-setting.reset.credentials` **不绑**(镜像 storage/sms/wechat
// D2=A,仅 SUPER_ADMIN 短路)。3 码端点 T2 实装,T1 期间为孤码(rbacmap F 项 WARN 预期,
// 非 FAIL;镜像保险 T1 / wechat T2 先例)。
// =========================================================================

// 镜像 WECHAT_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
const REALNAME_RESET_CREDENTIALS_CODE = 'realname-setting.reset.credentials';

const REALNAME_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'realname-setting.read.singleton',
    module: 'realname-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 Realname Verification Settings singleton row',
  },
  {
    code: 'realname-setting.update.singleton',
    module: 'realname-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新实名核验设置(upsert;不含凭证;production-like 禁 DEV_STUB)',
  },
  {
    code: REALNAME_RESET_CREDENTIALS_CODE,
    module: 'realname-setting',
    action: 'reset',
    resourceType: 'credentials',
    description:
      '重置腾讯云实名核验 secretId/secretKey(镜像 storage/sms/wechat D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
];

// Permission 全集(用于 step 1 upsert;14 rbac.* + 32 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B + 5 SMS + 4 WECHAT + 3 REALNAME = 81 条)
const ALL_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...RBAC_PERMISSION_SEED,
  ...PR_2A_PERMISSION_SEED,
  ...PR_2B_PERMISSION_SEED,
  ...USER_PERMISSION_SEED,
  ...AUDIT_LOG_PERMISSION_SEED,
  ...SMS_INFRA_PERMISSION_SEED,
  ...WECHAT_INFRA_PERMISSION_SEED,
  ...REALNAME_INFRA_PERMISSION_SEED,
];

// ops-admin 完整绑定集合(14 rbac.* + 44 PR-2A + 14 PR-2B + 6 PR-3B + 1 PR-4B + 4 SMS + 3 WECHAT + 2 REALNAME = 88 条;沿 D1=A / D2=B / D3=A / PR-4B D2=B / SMS E-3 / WECHAT 评审稿 §3.4 / REALNAME E-R-19;PR-2A 44 = base 20 + 终态 scoped-authz PR1 org.move.node + PR2 membership 4 + PR3 position 4 + position-rule 4 + PR4 position-assignment 4 + PR5 supervision-assignment 4 + PR6 role-binding 4 码,全绑 ops-admin 无过滤)
// 注:`storage-setting.reset.credentials` 从 PR_2B_PERMISSION_SEED 过滤掉(沿 PR-2 D2=A;§6.2)
// 注:`user.update.role` 从 USER_PERMISSION_SEED 过滤掉(沿 PR-3 D1=A;§6.2)
// 注:`audit-log.read.entry` 整条加入,不过滤(沿 PR-4 D2=B;§6.2)
// 注:`sms-setting.reset.credentials` 从 SMS_INFRA_PERMISSION_SEED 过滤掉(镜像 D2=A;评审稿 E-3)
// 注:`wechat-setting.reset.credentials` 从 WECHAT_INFRA_PERMISSION_SEED 过滤掉(镜像 D2=A;wechat 评审稿 §3.4)
// 注:`realname-setting.reset.credentials` 从 REALNAME_INFRA_PERMISSION_SEED 过滤掉(镜像 D2=A;招新评审稿 E-R-19)
const OPS_ADMIN_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...RBAC_PERMISSION_SEED,
  ...PR_2A_PERMISSION_SEED,
  ...PR_2B_PERMISSION_SEED.filter((p) => p.code !== PR_2B_RESET_CREDENTIALS_CODE),
  ...USER_PERMISSION_SEED.filter((p) => p.code !== PR_3B_USER_UPDATE_ROLE_CODE),
  ...AUDIT_LOG_PERMISSION_SEED,
  ...SMS_INFRA_PERMISSION_SEED.filter((p) => p.code !== SMS_RESET_CREDENTIALS_CODE),
  ...WECHAT_INFRA_PERMISSION_SEED.filter((p) => p.code !== WECHAT_RESET_CREDENTIALS_CODE),
  ...REALNAME_INFRA_PERMISSION_SEED.filter((p) => p.code !== REALNAME_RESET_CREDENTIALS_CODE),
];

// 运营管理员角色 code(沿 D7 §10.1 / §10.3 ops-admin 唯一公开 placeholder)
const OPS_ADMIN_ROLE_CODE = 'ops-admin';
const OPS_ADMIN_DISPLAY_NAME = '运营管理员';
const OPS_ADMIN_DESCRIPTION =
  'RBAC 自身配置 + 用户角色分配 + 配置类接口(PR-2A: dict / org / member-department / membership / contribution-rule / position / position-rule / position-assignment / supervision-assignment / role-binding + PR-2B: attachment-config / storage-setting + PR-3B: user 管理 6 条 + PR-4B: audit-log 读 1 条 + SMS: sms-setting / sms-send-log / user.phone.clear 4 条 + WECHAT: wechat-setting / user.wechat.clear 3 条 + REALNAME: realname-setting 2 条)的 meta 角色;14 rbac.* + 44 PR-2A + 14 PR-2B + 6 PR-3B + 1 PR-4B + 4 SMS + 3 WECHAT + 2 REALNAME = 88 条权限点;凭证 reset(storage / sms / wechat / realname)与 user 角色修改仅 SUPER_ADMIN';

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

// 终态 scoped-authz PR6(2026-07-01;冻结稿 §8.2):判权唯一读源 = global RoleBinding。
// seed 授予角色(ops-admin bootstrap + biz-admin 补挂)改写 RoleBinding(principalType=USER, scopeType=GLOBAL,
//   status=ACTIVE),**UserRole 表冻结、seed 不再写**(否则判权读 RoleBinding 看不到 seed 授予的角色)。
// 幂等:RoleBinding 无 Prisma 复合唯一键(active partial unique 手写),故 findFirst active → 缺则 create。
async function ensureGlobalUserRoleBinding(
  prisma: PrismaClient,
  userId: string,
  roleId: string,
): Promise<void> {
  const existing = await prisma.roleBinding.findFirst({
    where: {
      principalType: 'USER',
      principalId: userId,
      roleId,
      scopeType: 'GLOBAL',
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!existing) {
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
  }
}

// 终态 scoped-authz PR6:某角色的活跃 GLOBAL 持有者中 active user 数(RoleBinding 无 user relation〔principalId 多态〕,
//   故取 active global 绑定的 principalId 再 count active user =「至少 1 个活跃持有者」强校验的等价语义)。
async function countActiveGlobalRoleHolders(
  prisma: PrismaClient,
  roleCode: string,
): Promise<number> {
  const bindings = await prisma.roleBinding.findMany({
    where: {
      principalType: 'USER',
      scopeType: 'GLOBAL',
      status: 'ACTIVE',
      deletedAt: null,
      role: { code: roleCode, deletedAt: null },
    },
    select: { principalId: true },
  });
  const ids = bindings.map((b) => b.principalId).filter((id): id is string => id !== null);
  if (ids.length === 0) return 0;
  return prisma.user.count({
    where: { id: { in: ids }, deletedAt: null, status: UserStatus.ACTIVE },
  });
}

// V2.x C-6 RBAC 实施 PR #8:RBAC seed/bootstrap 主函数。
// 沿 D7 v1.1 §10 + 用户拍板六项决策。
// 幂等性:全部 upsert(Permission.code / RbacRole.code / RolePermission 复合唯一键);
// 终态 scoped-authz PR6 起 bootstrap 授予改写 global RoleBinding(ensureGlobalUserRoleBinding 幂等)。
async function seedRbac(prisma: PrismaClient): Promise<void> {
  // 1. upsert Permission 全集(14 rbac.* + 24 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B + 5 SMS + 4 WECHAT + 3 REALNAME = 73 条;
  //    沿 D7 §10.2 + 历次 P0-F / 基建 / 终态 scoped-authz PR1(org.move.node)·PR2(membership 4 码)增量)
  //    全部 73 条都进 Permission 表(含 4 把 reset.credentials + user.update.role);
  //    ops-admin 仅绑 68 条(沿 PR-2 / SMS / WECHAT / REALNAME D2=A 凭证收紧 + PR-3 D1=A user.update.role 收紧;PR-4 D2=B audit-log 整条加入)
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
    `[seed] RBAC + PR-2A + PR-2B + PR-3B + PR-4B + SMS + WECHAT + REALNAME permissions ensured (${RBAC_PERMISSION_SEED.length} rbac.* + ${PR_2A_PERMISSION_SEED.length} PR-2A + ${PR_2B_PERMISSION_SEED.length} PR-2B + ${USER_PERMISSION_SEED.length} PR-3B + ${AUDIT_LOG_PERMISSION_SEED.length} PR-4B + ${SMS_INFRA_PERMISSION_SEED.length} SMS + ${WECHAT_INFRA_PERMISSION_SEED.length} WECHAT + ${REALNAME_INFRA_PERMISSION_SEED.length} REALNAME = ${ALL_PERMISSION_SEED.length} entries)`,
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

  // 3. upsert RolePermission 映射:ops-admin → 14 rbac.* + 24 PR-2A + 14 PR-2B + 6 PR-3B + 1 PR-4B + 4 SMS + 3 WECHAT + 2 REALNAME = 68 条
  //    (沿 D7 §10.3 + P0-F PR-2A 2026-05-18 D1=A 全绑 + D3=A 软删放宽 + PR-2B D1=A + D2=A 凭证收紧
  //     + P0-F PR-3B 2026-05-18 D1=A user.update.role 收紧 + D2=B user.reset.password 放宽 + D3=A 其余 5 条全绑
  //     + P0-F PR-4B 2026-05-18 D2=B audit-log.read.entry 整条加入)
  //    复合唯一键 roleId_permissionId(schema @@unique([roleId, permissionId]))
  //    OPS_ADMIN_PERMISSION_SEED 已在常量定义处过滤:
  //      - `storage-setting.reset.credentials`(PR-2 D2=A)
  //      - `user.update.role`(PR-3 D1=A)
  //      - `audit-log.read.entry`(PR-4 D2=B,不过滤,整条加入)
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
    `[seed] RBAC role-permissions ensured ('${opsAdminRole.code}' ↔ ${allPermissions.length} permissions: rbac.* + PR-2A + PR-2B + PR-3B + PR-4B; '${PR_2B_RESET_CREDENTIALS_CODE}' skipped per PR-2 D2=A; '${PR_3B_USER_UPDATE_ROLE_CODE}' skipped per PR-3 D1=A)`,
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
    // 终态 scoped-authz PR6:授予改写 global RoleBinding(判权唯一读源;UserRole 表冻结不写)。
    await ensureGlobalUserRoleBinding(prisma, targetUserId, opsAdminRole.id);
  }

  // 5. 强校验(沿 D7 §10.4 + §6.3 最后一个 ops-admin 保护范式):
  //    seed 完成后 **至少 1 个活跃持有者(active user × active global ops-admin 绑定)**,否则 throw 退出。
  //    检查范围:user 活跃 + ops-admin 角色未软删(理论本 seed 刚 ensure 应满足,
  //    但若 fallback 路径没找到 SUPER_ADMIN 且无 env,此处会 throw — 这是设计预期)。
  const activeOpsAdminCount = await countActiveGlobalRoleHolders(prisma, OPS_ADMIN_ROLE_CODE);
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

// Slow-4 业务面 RBAC 接入(2026-06-11,goal「权限双轨收口」T1;
// 冻结评审稿 docs/archive/reviews/slow4-rbac-business-face-review.md §4 / §5):
// 43 条业务面权限码 + `biz-admin` 内置角色(Slow-3 决议:ADMIN 内置角色边界 = 全量业务权限;
// 2026-06-13 保险模块 +7:team-insurance-policy 6 + member-insurance 1,全绑,
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.4 / E-6)。
//
// **不绑项**(评审稿 §6):
// - `member.delete.record`:members DELETE 今天仅 SUPER_ADMIN(@Roles(SUPER_ADMIN)),
//   码进 Permission 表但不绑 biz-admin(镜像 PR-3 D1=A `user.update.role` 收紧范式);
// - attachment 存量 20 码:attachments 已是 R 模式,未持 RBAC 角色的 ADMIN 今天即 30100;
//   绑入 = ADMIN 凭空获权,违零行为漂移 → 一条不绑。
//
// **幂等不变式**(评审稿 D-S4-7):每个 `role=ADMIN && deletedAt=null` 用户持有 biz-admin,
// 每次 seed 自动补挂 + 强校验(镜像 seedRbac「至少 1 个 ops-admin」强校验范式);
// 含 DISABLED(禁用→重启用周期内无需重跑 seed 即保持零漂移);
// 运行时新建的 ADMIN 不自动持有,走既有 POST /api/system/v1/users/:userId/roles 显式授予。

const MEMBER_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member.read.record',
    module: 'member',
    action: 'read',
    resourceType: 'record',
    description: '查看队员(列表 + 详情共用 read,沿 PR-4B D4=A)',
  },
  {
    code: 'member.create.record',
    module: 'member',
    action: 'create',
    resourceType: 'record',
    description: '创建队员(memberNo 全局唯一不复用)',
  },
  {
    code: 'member.update.record',
    module: 'member',
    action: 'update',
    resourceType: 'record',
    description: '更新队员(displayName / gradeCode;禁改 memberNo / status)',
  },
  {
    code: 'member.update.status',
    module: 'member',
    action: 'update',
    resourceType: 'status',
    description: '切换队员 status(ACTIVE↔INACTIVE;镜像 user.update.status 命名)',
  },
  {
    code: 'member.delete.record',
    module: 'member',
    action: 'delete',
    resourceType: 'record',
    description: '软删队员(仅 SUPER_ADMIN 短路;不绑 biz-admin,D1=A 镜像;评审稿 §6)',
  },
];

const MEMBER_PROFILE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member-profile.read.record',
    module: 'member-profile',
    action: 'read',
    resourceType: 'record',
    description: '查看队员扩展档案(1:1 子资源;含敏感字段)',
  },
  {
    code: 'member-profile.create.record',
    module: 'member-profile',
    action: 'create',
    resourceType: 'record',
    description: '创建队员扩展档案',
  },
  {
    code: 'member-profile.update.record',
    module: 'member-profile',
    action: 'update',
    resourceType: 'record',
    description: '部分更新队员扩展档案',
  },
];

const EMERGENCY_CONTACT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'emergency-contact.read.record',
    module: 'emergency-contact',
    action: 'read',
    resourceType: 'record',
    description: '查看队员紧急联系人',
  },
  {
    code: 'emergency-contact.create.record',
    module: 'emergency-contact',
    action: 'create',
    resourceType: 'record',
    description: '新增队员紧急联系人',
  },
  {
    code: 'emergency-contact.update.record',
    module: 'emergency-contact',
    action: 'update',
    resourceType: 'record',
    description: '更新队员紧急联系人',
  },
  {
    code: 'emergency-contact.delete.record',
    module: 'emergency-contact',
    action: 'delete',
    resourceType: 'record',
    description: '软删队员紧急联系人',
  },
];

const CERTIFICATE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'certificate.read.record',
    module: 'certificate',
    action: 'read',
    resourceType: 'record',
    description: '查看队员证书(列表 + 详情 + qualification-flag 共用 read)',
  },
  {
    code: 'certificate.create.record',
    module: 'certificate',
    action: 'create',
    resourceType: 'record',
    description: '新增队员证书(初始 pending)',
  },
  {
    code: 'certificate.update.record',
    module: 'certificate',
    action: 'update',
    resourceType: 'record',
    description: '部分更新队员证书(禁系统字段)',
  },
  {
    code: 'certificate.delete.record',
    module: 'certificate',
    action: 'delete',
    resourceType: 'record',
    description: '软删队员证书',
  },
  {
    code: 'certificate.verify.record',
    module: 'certificate',
    action: 'verify',
    resourceType: 'record',
    description: '证书核验通过(pending → verified)',
  },
  {
    code: 'certificate.reject.record',
    module: 'certificate',
    action: 'reject',
    resourceType: 'record',
    description: '证书核验拒绝(pending → rejected)',
  },
];

const ACTIVITY_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'activity.create.record',
    module: 'activity',
    action: 'create',
    resourceType: 'record',
    description: '创建活动(initial draft;列表/详情无码仅登录,评审稿 §3.5)',
  },
  {
    code: 'activity.update.record',
    module: 'activity',
    action: 'update',
    resourceType: 'record',
    description: '部分更新活动(cancelled 拒改)',
  },
  {
    code: 'activity.delete.record',
    module: 'activity',
    action: 'delete',
    resourceType: 'record',
    description: '软删活动(D3:删除 ≠ 取消)',
  },
  {
    code: 'activity.publish.record',
    module: 'activity',
    action: 'publish',
    resourceType: 'record',
    description: '发布活动(draft → published)',
  },
  {
    code: 'activity.cancel.record',
    module: 'activity',
    action: 'cancel',
    resourceType: 'record',
    description: '取消活动(* → cancelled)',
  },
];

const ACTIVITY_REGISTRATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'activity-registration.read.record',
    module: 'activity-registration',
    action: 'read',
    resourceType: 'record',
    description: '查看活动报名(列表 + CSV 导出共用 read)',
  },
  {
    code: 'activity-registration.create.record',
    module: 'activity-registration',
    action: 'create',
    resourceType: 'record',
    description: 'ADMIN 代报名(Q-A3)',
  },
  {
    code: 'activity-registration.approve.record',
    module: 'activity-registration',
    action: 'approve',
    resourceType: 'record',
    description: '报名审核通过(pending → pass)',
  },
  {
    code: 'activity-registration.reject.record',
    module: 'activity-registration',
    action: 'reject',
    resourceType: 'record',
    description: '报名审核拒绝(pending → reject)',
  },
  {
    code: 'activity-registration.cancel.record',
    module: 'activity-registration',
    action: 'cancel',
    resourceType: 'record',
    description: '管理员代取消报名(pending|pass → cancelled)',
  },
];

const ATTENDANCE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'attendance.create.sheet',
    module: 'attendance',
    action: 'create',
    resourceType: 'sheet',
    description: '提交考勤单据(Sheet + N records)',
  },
  {
    code: 'attendance.read.sheet',
    module: 'attendance',
    action: 'read',
    resourceType: 'sheet',
    description: '查看考勤单据(列表 + 详情 + review-detail 共用 read)',
  },
  {
    code: 'attendance.update.sheet',
    module: 'attendance',
    action: 'update',
    resourceType: 'sheet',
    description: '编辑 pending 考勤单据(D38 snapshot + version+1)',
  },
  {
    code: 'attendance.delete.sheet',
    module: 'attendance',
    action: 'delete',
    resourceType: 'sheet',
    description: '软删 pending 考勤单据(级联软删 records)',
  },
  {
    code: 'attendance.approve.sheet',
    module: 'attendance',
    action: 'approve',
    resourceType: 'sheet',
    description: 'APD 一级通过(pending → pending_final_review)',
  },
  {
    code: 'attendance.reject.sheet',
    module: 'attendance',
    action: 'reject',
    resourceType: 'sheet',
    description: 'APD 一级驳回(pending → rejected)',
  },
  {
    code: 'attendance.final-approve.sheet',
    module: 'attendance',
    action: 'final-approve',
    resourceType: 'sheet',
    description: '终审通过(pending_final_review → approved;贡献值生效;ADMIN 级终审沿 P1-5 方案 A)',
  },
  {
    code: 'attendance.final-reject.sheet',
    module: 'attendance',
    action: 'final-reject',
    resourceType: 'sheet',
    description: '终审驳回(pending_final_review → final_rejected)',
  },
];

// 保险模块 T1(2026-06-13;冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.4):
// 队保单 6 码 + admin 查队员自购保险 1 码,全部绑 biz-admin(E-6,无 member.delete.record 式例外);
// App 自助端点(app/v1/me/insurances)走 self-scope,**无 RBAC 码**(goal §1 拍板)。
const TEAM_INSURANCE_POLICY_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'team-insurance-policy.read.record',
    module: 'team-insurance-policy',
    action: 'read',
    resourceType: 'record',
    description: '查看队统一保单(列表 + 详情 + 覆盖名单共用 read)',
  },
  {
    code: 'team-insurance-policy.create.record',
    module: 'team-insurance-policy',
    action: 'create',
    resourceType: 'record',
    description: '创建队统一保单(一张 = 一条)',
  },
  {
    code: 'team-insurance-policy.update.record',
    module: 'team-insurance-policy',
    action: 'update',
    resourceType: 'record',
    description: '部分更新队统一保单',
  },
  {
    code: 'team-insurance-policy.delete.record',
    module: 'team-insurance-policy',
    action: 'delete',
    resourceType: 'record',
    description: '软删队统一保单(不级联覆盖行,评审稿 E-4)',
  },
  {
    code: 'team-insurance-policy.add.member',
    module: 'team-insurance-policy',
    action: 'add',
    resourceType: 'member',
    description: '保单覆盖名单加人(单加 + 全体在册一键加共用;一键加幂等仅 active 未软删)',
  },
  {
    code: 'team-insurance-policy.remove.member',
    module: 'team-insurance-policy',
    action: 'remove',
    resourceType: 'member',
    description: '保单覆盖名单移除队员(软删覆盖行;partial unique 允许重新加入)',
  },
];

const MEMBER_INSURANCE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member-insurance.read.other',
    module: 'member-insurance',
    action: 'read',
    resourceType: 'other',
    description: 'admin 查看队员自购保险(本人侧走 App self-scope 无码;评审稿 E-7)',
  },
];

// 招新一期 T1(2026-06-18;冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md §3.4):
// recruitment-cycle 3 码 + recruitment-application 2 码,全部绑 biz-admin(E-R-19,无例外);
// 公开报名/查询走 open/v1 无账号 pre-auth,**无 RBAC 码**(分叉①/②);取证件照 signed-URL 复用
// recruitment-application.read.record(不另加码,配套②)。5 码端点 T3 实装,T1 期间孤码(WARN 预期)。
// 招新二期 T1(2026-06-19;冻结评审稿 recruitment-phase2-review.md §3.4 / E-R2-11):recruitment-application
// +3 码(mark.threshold / evaluate.assessment / promote.member),全绑 biz-admin;公示名单复用 read.record;
// 端点 T2/T3 实装,T1 期间孤码(WARN 预期)。
// 招新闭环优化 S3(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §11 / Q-P4-10):
// recruitment-application +1 码 read.sensitive(敏感查看),全绑 biz-admin 无例外;read.record 语义收窄为脱敏。
// 实装即用(详情明文闸 + 证件照 signed-URL),无孤码;上文「signed-URL 复用 read.record」自本切片起改判 read.sensitive。
const RECRUITMENT_CYCLE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'recruitment-cycle.read.record',
    module: 'recruitment-cycle',
    action: 'read',
    resourceType: 'record',
    description: '查看招新轮次(列表 + 详情共用 read)',
  },
  {
    code: 'recruitment-cycle.create.record',
    module: 'recruitment-cycle',
    action: 'create',
    resourceType: 'record',
    description: '创建招新轮次(默认 closed,显式开)',
  },
  {
    code: 'recruitment-cycle.update.record',
    module: 'recruitment-cycle',
    action: 'update',
    resourceType: 'record',
    description: '更新招新轮次(开/关 + 容量 + 通知配置;service 强校验至多一个 open 轮)',
  },
];

const RECRUITMENT_APPLICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'recruitment-application.read.record',
    module: 'recruitment-application',
    action: 'read',
    resourceType: 'record',
    description:
      '普通查看:脱敏列表 + 脱敏详情 + 公示名单 + 工作台 stats(明文证件号/手机 + 证件照 signed-URL 走 read.sensitive;读记 placeholder 审计)',
  },
  // 招新闭环优化 S3(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §11.1 / Q-P4-10):
  // 敏感查看从 read.record 切出。read.record 语义收窄为脱敏;明文证件号/手机(详情)+ 证件照 signed-URL 改判此码。
  // 默认绑 biz-admin(沿 BIZ_ADMIN_PERMISSION_SEED 过滤;§11.2 迁移:现持 read.record 的 biz-admin 补挂本码 → 明文行为不回退)。
  {
    code: 'recruitment-application.read.sensitive',
    module: 'recruitment-application',
    action: 'read',
    resourceType: 'sensitive',
    description:
      '敏感查看:详情明文证件号/手机 + 取证件照 signed-URL(从 read.record 切出;招新闭环优化 S3 §11.1)',
  },
  {
    code: 'recruitment-application.resolve.manual',
    module: 'recruitment-application',
    action: 'resolve',
    resourceType: 'manual',
    description: '人工待核 resolve(外籍等;通过→发临时编号 / 不通过→未通过;评审稿分叉④)',
  },
  // 招新二期 +3(2026-06-19;评审稿 recruitment-phase2-review.md §3.4 / E-R2-11,全绑 biz-admin 无例外)
  {
    code: 'recruitment-application.mark.threshold',
    module: 'recruitment-application',
    action: 'mark',
    resourceType: 'threshold',
    description:
      '标/清门槛完成(巡山×2/培训/红十字/BSAFE;幂等;末次完成自动推进待综合评定;评审稿 E-R2-2)',
  },
  {
    code: 'recruitment-application.evaluate.assessment',
    module: 'recruitment-application',
    action: 'evaluate',
    resourceType: 'assessment',
    description:
      '综合评定/淘汰(单一人工闸;通过→公示 / 不通过→未通过;门槛超期 verified 态淘汰;评审稿 D-R2-3)',
  },
  {
    code: 'recruitment-application.promote.member',
    module: 'recruitment-application',
    action: 'promote',
    resourceType: 'member',
    description:
      '一键发号:公示报名按拼音序批量发永久编号 + 建 User+Member+档案+紧急联系人(评审稿 D-R2-5)',
  },
];

// 招新三期(入队:志愿者→队员)T2(2026-06-19;冻结评审稿 recruitment-phase3-review.md §3.4 / E-J-8):
// team-join-cycle 3 码 + team-join-application 3 码(read / mark.gate / evaluate.assessment),全绑 biz-admin。
// app/v1 自助面 self-scope **无 RBAC 码**(镜像 insurances me)。join.member(一键入队)随 T4 controller 落
// (避免 rbacmap 孤码:本 PR 码全有 admin controller call-site)。
const TEAM_JOIN_CYCLE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'team-join-cycle.read.record',
    module: 'team-join-cycle',
    action: 'read',
    resourceType: 'record',
    description: '查看入队轮(列表 + 详情共用 read)',
  },
  {
    code: 'team-join-cycle.create.record',
    module: 'team-join-cycle',
    action: 'create',
    resourceType: 'record',
    description: '创建入队轮(默认 closed,显式开)',
  },
  {
    code: 'team-join-cycle.update.record',
    module: 'team-join-cycle',
    action: 'update',
    resourceType: 'record',
    description: '更新入队轮(开/关 + 轮次名;service 强校验至多一个 open 轮)',
  },
];

const TEAM_JOIN_APPLICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'team-join-application.read.record',
    module: 'team-join-application',
    action: 'read',
    resourceType: 'record',
    description: 'admin 查看入队申请(列表 + 详情;详情含各 gate 实况 + 实时贡献值汇总)',
  },
  {
    code: 'team-join-application.mark.gate',
    module: 'team-join-application',
    action: 'mark',
    resourceType: 'gate',
    description:
      '标 gate(8 通用 + 4 专业队;通过/未通过 + 完成日 + dept-assessment 可延长期;幂等;末次 8 通用全过 + 贡献值≥5 自动→待综合评估;评审稿 §4.1)',
  },
  {
    code: 'team-join-application.evaluate.assessment',
    module: 'team-join-application',
    action: 'evaluate',
    resourceType: 'assessment',
    description:
      '综合评估/淘汰(单一人工闸;通过→待入队 / 不通过→未通过;joining 门槛超期淘汰;评审稿 §4.5)',
  },
  // 招新三期入队 T4(2026-06-19;评审稿 §4.5):一键入队(志愿者→队员;设部门 + 级别 level-1),全绑 biz-admin。
  {
    code: 'team-join-application.join.member',
    module: 'team-join-application',
    action: 'join',
    resourceType: 'member',
    description:
      '一键入队:approved 申请单事务设部门 + 级别 level-1 → joined(原子/幂等;两层身份转换;评审稿 §4.5)',
  },
];

// CMS 内容发布模块(第 28 模块,2026-06-21;评审稿 §7):content.* 5 码,全绑 biz-admin。
const CONTENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'content.read.record',
    module: 'content',
    action: 'read',
    resourceType: 'record',
    description:
      'admin 查看内容(列表 + 详情;全状态全可见档);亦作 app/v1 management 可见档判定信号(评审稿 §4.1)',
  },
  {
    code: 'content.create.record',
    module: 'content',
    action: 'create',
    resourceType: 'record',
    description: '新建内容草稿(先草稿拿 id 再上传封面 / 正文图 / 附件;评审稿 §5.3)',
  },
  {
    code: 'content.update.record',
    module: 'content',
    action: 'update',
    resourceType: 'record',
    description: '更新内容(draft / published 可改,archived 冻结);设 / 清封面',
  },
  {
    code: 'content.delete.record',
    module: 'content',
    action: 'delete',
    resourceType: 'record',
    description: '软删内容(任意态)',
  },
  {
    code: 'content.publish.record',
    module: 'content',
    action: 'publish',
    resourceType: 'record',
    description: '内容状态机:publish / unpublish / archive(立即生效无 cron;评审稿 §3)',
  },
];

// CMS 附件 owner(content-image / content-file)写路径 coarse 权限码(沿 attachment.*.activity 粗粒度范式;
// 全绑 biz-admin;α 决议)。读路径由 content 自签 + 文章可见级闸控,不走这些码(评审稿 §5.2 / §5.4)。
// 注:这 4 码 module='attachment' 但归入 BIZ_PERMISSION_SEED 绑 biz-admin —— 内容写路径授权,
// 演进 Slow-4「biz-admin 不含 attachment.* 码」不变式为「仅含 CMS content-* 4 码」(评审稿 §7;
// seed-biz-admin.e2e 的 attachment.* 断言同步 true-up)。
const CONTENT_ATTACHMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'attachment.upload.content-image',
    module: 'attachment',
    action: 'upload',
    resourceType: 'content-image',
    description: '上传内容图片(封面 / 正文图;经 AttachmentsService 写路径判权)',
  },
  {
    code: 'attachment.delete.content-image',
    module: 'attachment',
    action: 'delete',
    resourceType: 'content-image',
    description: '删除内容图片附件',
  },
  {
    code: 'attachment.upload.content-file',
    module: 'attachment',
    action: 'upload',
    resourceType: 'content-file',
    description: '上传内容文件附件',
  },
  {
    code: 'attachment.delete.content-file',
    module: 'attachment',
    action: 'delete',
    resourceType: 'content-file',
    description: '删除内容文件附件',
  },
];

// 统一通知模块 S1 站内信渠道(2026-06-25;冻结评审稿
// docs/archive/reviews/unified-notification-dispatcher-review.md §9.2 + member-notification-review.md §4):
// notification.* 5 码,全绑 biz-admin(镜像 content;app 会员读取面零码 = canUseApp 闸 + 可见级)。
// 不开 read.other / publish.emergency(通知是广播无 owner-scope;紧急召集仍是 publish 一种;沿原 T0 §4)。
const NOTIFICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'notification.read.record',
    module: 'notification',
    action: 'read',
    resourceType: 'record',
    description: 'admin 查看通知(列表 + 详情;全状态全可见档;回显已读人数)',
  },
  {
    code: 'notification.create.record',
    module: 'notification',
    action: 'create',
    resourceType: 'record',
    description: '新建通知草稿',
  },
  {
    code: 'notification.update.record',
    module: 'notification',
    action: 'update',
    resourceType: 'record',
    description: '更新通知(draft / published 可改,archived 冻结)',
  },
  {
    code: 'notification.delete.record',
    module: 'notification',
    action: 'delete',
    resourceType: 'record',
    description: '软删通知(任意态)',
  },
  {
    code: 'notification.publish.record',
    module: 'notification',
    action: 'publish',
    resourceType: 'record',
    description: '通知状态机:publish(推送)/ unpublish(撤回)/ archive(立即生效无 cron)',
  },
  // 统一通知 S2(2026-06-25;微信订阅 quota 渠道):模板配置写权(运营改 templateId 不重部署,D-N3)。
  // 读模板配置复用 notification.read.record(不另开 read 码,§9.2「至多 +1」预算);全绑 biz-admin。
  {
    code: 'notification.update.template',
    module: 'notification',
    action: 'update',
    resourceType: 'template',
    description: '配置通知类型 → 微信订阅模板 ID + 启用态(upsert;运营可配)',
  },
  // 统一通知 S5(2026-06-27;短信兜底渠道):admin 显式发起短信(紧急召集)成本动作单独 gating
  // (评审稿 §9.2 / D-N4;计费确认必需;全绑 biz-admin)。
  {
    code: 'notification.send.sms',
    module: 'notification',
    action: 'send',
    resourceType: 'sms',
    description: 'admin 显式发起短信兜底(紧急召集;计费确认必需,confirmed=true 才真发)',
  },
];

// D1=A 镜像:members DELETE 仅 SUPER_ADMIN 短路;码进 Permission 表但不绑 biz-admin(评审稿 §6)
const MEMBER_DELETE_RECORD_CODE = 'member.delete.record';

// 业务面权限码全集(51 条 = member 5 + member-profile 3 + emergency-contact 4 + certificate 6 +
// activity 5 + activity-registration 5 + attendance 8〔Slow-4 评审稿 §4〕
// + team-insurance-policy 6 + member-insurance 1〔保险模块评审稿 §3.4,2026-06-13〕
// + recruitment-cycle 3 + recruitment-application 5〔招新一期 2 §3.4 2026-06-18 + 招新二期 +3 §3.4 2026-06-19〕)
const BIZ_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...MEMBER_PERMISSION_SEED,
  ...MEMBER_PROFILE_PERMISSION_SEED,
  ...EMERGENCY_CONTACT_PERMISSION_SEED,
  ...CERTIFICATE_PERMISSION_SEED,
  ...ACTIVITY_PERMISSION_SEED,
  ...ACTIVITY_REGISTRATION_PERMISSION_SEED,
  ...ATTENDANCE_PERMISSION_SEED,
  ...TEAM_INSURANCE_POLICY_PERMISSION_SEED,
  ...MEMBER_INSURANCE_PERMISSION_SEED,
  ...RECRUITMENT_CYCLE_PERMISSION_SEED,
  ...RECRUITMENT_APPLICATION_PERMISSION_SEED,
  ...TEAM_JOIN_CYCLE_PERMISSION_SEED,
  ...TEAM_JOIN_APPLICATION_PERMISSION_SEED,
  ...CONTENT_PERMISSION_SEED,
  ...CONTENT_ATTACHMENT_PERMISSION_SEED,
  ...NOTIFICATION_PERMISSION_SEED,
];

// biz-admin 绑定集合(50 条 = 51 过滤 member.delete.record;Slow-4 §5/§6 + 保险 E-6 + 招新 E-R-19/E-R2-11)
const BIZ_ADMIN_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = BIZ_PERMISSION_SEED.filter(
  (p) => p.code !== MEMBER_DELETE_RECORD_CODE,
);

const BIZ_ADMIN_ROLE_CODE = 'biz-admin';
const BIZ_ADMIN_DISPLAY_NAME = '业务管理员';
const BIZ_ADMIN_DESCRIPTION =
  '业务面全量权限 meta 角色(Slow-3 决议 2026-06-11:ADMIN 内置角色边界 = 全量业务权限;Slow-4 §5 + 保险 §3.4 + 招新一/二/三期 §3.4 + 招新闭环优化 S3 §11 + CMS 内容模块评审稿 §7 + 统一通知模块 S1/S2/S5 §9.2):member 5 + member-profile 3 + emergency-contact 4 + certificate 6 + activity 5 + activity-registration 5 + attendance 8 + team-insurance-policy 6 + member-insurance 1 + recruitment-cycle 3 + recruitment-application 6 + team-join-cycle 3 + team-join-application 4 + content 5 + content-attachment 4 + notification 7 = 75 条中绑 74;member.delete.record 仅 SUPER_ADMIN(D1=A 镜像);attachment 存量 20 码(member / certificate / activity)不在本角色,CMS content-image / content-file 写路径 4 码因内容授权绑入(评审稿 α / §5.2);notification 7 码(S1 站内信 5 + S2 微信模板配置 1 + S5 短信发起 1)统一通知模块绑入(2026-06-25 ~ 2026-06-27,评审稿 §9.2);每个 ADMIN 用户由 seed 自动补挂本角色';

// Slow-4 T1(36/35)+ 保险模块 T1 增量(2026-06-13,+7 全绑 → 43/42)+ 招新一期 T1 增量(2026-06-18,+5 全绑 → 48/47):
// 业务面权限点 + biz-admin 角色 + 绑定 + ADMIN 全员补挂 + 强校验。
// 幂等性:全部 upsert(Permission.code / RbacRole.code / RolePermission 与 UserRole 复合唯一键),
// 连续跑两次数量与 id 稳定;不覆盖运营运行时调整(update: {} 范式)。
async function seedBizAdminRbac(prisma: PrismaClient): Promise<void> {
  // 1. upsert 48 条业务面 Permission
  for (const perm of BIZ_PERMISSION_SEED) {
    await prisma.permission.upsert({
      where: { code: perm.code },
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
    `[seed] business permissions ensured (${BIZ_PERMISSION_SEED.length} entries: ` +
      `member ${MEMBER_PERMISSION_SEED.length} + member-profile ${MEMBER_PROFILE_PERMISSION_SEED.length} + ` +
      `emergency-contact ${EMERGENCY_CONTACT_PERMISSION_SEED.length} + certificate ${CERTIFICATE_PERMISSION_SEED.length} + ` +
      `activity ${ACTIVITY_PERMISSION_SEED.length} + activity-registration ${ACTIVITY_REGISTRATION_PERMISSION_SEED.length} + ` +
      `attendance ${ATTENDANCE_PERMISSION_SEED.length} + ` +
      `team-insurance-policy ${TEAM_INSURANCE_POLICY_PERMISSION_SEED.length} + ` +
      `member-insurance ${MEMBER_INSURANCE_PERMISSION_SEED.length} + ` +
      `recruitment-cycle ${RECRUITMENT_CYCLE_PERMISSION_SEED.length} + ` +
      `recruitment-application ${RECRUITMENT_APPLICATION_PERMISSION_SEED.length} + ` +
      `team-join-cycle ${TEAM_JOIN_CYCLE_PERMISSION_SEED.length} + ` +
      `team-join-application ${TEAM_JOIN_APPLICATION_PERMISSION_SEED.length} + ` +
      `content ${CONTENT_PERMISSION_SEED.length} + ` +
      `content-attachment ${CONTENT_ATTACHMENT_PERMISSION_SEED.length} + ` +
      `notification ${NOTIFICATION_PERMISSION_SEED.length})`,
  );

  // 2. upsert biz-admin RbacRole
  const bizAdminRole = await prisma.rbacRole.upsert({
    where: { code: BIZ_ADMIN_ROLE_CODE },
    update: {},
    create: {
      code: BIZ_ADMIN_ROLE_CODE,
      displayName: BIZ_ADMIN_DISPLAY_NAME,
      description: BIZ_ADMIN_DESCRIPTION,
    },
    select: { id: true, code: true },
  });
  console.log(`[seed] RBAC role '${bizAdminRole.code}' ensured`);

  // 3. upsert RolePermission 映射:biz-admin → 47 条(过滤 member.delete.record)
  const bizPermissions = await prisma.permission.findMany({
    where: { code: { in: BIZ_ADMIN_PERMISSION_SEED.map((p) => p.code) } },
    select: { id: true, code: true },
  });
  if (bizPermissions.length !== BIZ_ADMIN_PERMISSION_SEED.length) {
    throw new Error(
      `[seed] Slow-4 seed 强校验失败:期望找到 ${BIZ_ADMIN_PERMISSION_SEED.length} 条 ` +
        `biz-admin 绑定 Permission,实际查到 ${bizPermissions.length} 条;` +
        'BIZ_PERMISSION_SEED 与 BIZ_ADMIN_PERMISSION_SEED 可能不同步',
    );
  }
  for (const perm of bizPermissions) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: bizAdminRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: bizAdminRole.id, permissionId: perm.id },
    });
  }
  console.log(
    `[seed] RBAC role-permissions ensured ('${bizAdminRole.code}' ↔ ${bizPermissions.length} permissions; ` +
      `'${MEMBER_DELETE_RECORD_CODE}' skipped per Slow-4 评审稿 §6 D1=A 镜像)`,
  );

  // 4. 幂等补挂(评审稿 D-S4-7):每个 role=ADMIN && deletedAt=null 用户 ensure biz-admin
  //    (含 DISABLED;软删除外)。终态 scoped-authz PR6:授予改写 global RoleBinding(ensureGlobalUserRoleBinding 幂等)。
  const adminUsers = await prisma.user.findMany({
    where: { role: Role.ADMIN, deletedAt: null },
    select: { id: true },
  });
  for (const u of adminUsers) {
    await ensureGlobalUserRoleBinding(prisma, u.id, bizAdminRole.id);
  }

  // 5. 强校验(镜像 seedRbac ops-admin ≥1 范式):补挂后不允许存在
  //    「非软删 ADMIN 且未持 active global biz-admin 绑定」的用户,否则 throw 退出。
  //    RoleBinding 无 User relation(principalId 多态),故取 ADMIN 集 - 已持 biz-admin 绑定集。
  const adminIds = adminUsers.map((u) => u.id);
  const boundBizAdminBindings = await prisma.roleBinding.findMany({
    where: {
      principalType: 'USER',
      scopeType: 'GLOBAL',
      status: 'ACTIVE',
      deletedAt: null,
      roleId: bizAdminRole.id,
      principalId: { in: adminIds },
    },
    select: { principalId: true },
  });
  const boundAdminIds = new Set(boundBizAdminBindings.map((b) => b.principalId));
  const unattachedAdminCount = adminIds.filter((id) => !boundAdminIds.has(id)).length;
  if (unattachedAdminCount > 0) {
    throw new Error(
      `[seed] Slow-4 biz-admin 强校验失败:仍有 ${unattachedAdminCount} 个非软删 ADMIN 未持有 biz-admin` +
        '(幂等不变式「每个 Role.ADMIN 用户持有 biz-admin」被破坏;沿评审稿 D-S4-7)。',
    );
  }
  console.log(
    `[seed] biz-admin bootstrap done (ADMIN holders attached=${adminUsers.length}, unattached=${unattachedAdminCount})`,
  );
}

// 终态 scoped-authz PR7「职务→角色 policy」(2026-07-01 goal;冻结稿 §3.7 / §2.4 BD-1/BD-3 / R5;序列 PR7/12)。
//
// 3 个管理/监督角色(goal 本刀内定拍板:合并冻结稿草案原提的 team-manager/dept-manager 二分为统一
// `org-admin`,scope 相对"任职组织"〔TREE〕天然区分 root 全组织 vs 非 root 本队/本部,无需
// conditionJson 分流):
// - `org-admin`(队长 team-leader / 部长 dept-leader 合用,本组织〔含子树〕全业务管理):
//   码集 = biz-admin 74 业务码过滤〔attendance.final-{approve,reject}.sheet(BD-2:终审归 APD 类中枢
//   显式 RoleBinding,org-admin 不含)+ recruitment-application.read.sensitive(敏感明文,§4.2 分级)〕,
//   **另排除 `recruitment-*`/`team-join-*` 全前缀族**(招新/入队是中央流程,不随"本组织业务管理"
//   下放——本刀 runner 判断,goal 原文标注倾向排除、供 PR 评审复核;若维护者认为应部分/全部纳入,
//   属可逆调整,后续 PR 加回 RolePermission 绑定即可,不影响本表结构)。
// - `group-manager`(组长 group-leader,轻量,本组范围):本组资料/内容/考勤一级读写
//   (attachment.upload.*/view.* 现有 20 码族中 member/certificate 的 self+other + activity 共 10 条 +
//   member-profile/certificate/emergency-contact 只读 3 条 + content.* 5 条〔不含 content-image/
//   content-file 附件写,那是 CMS "content-attachment" 独立码族,本刀不纳入,后续如需再加〕+
//   attendance 一级读/approve/reject 3 条〔不含 final-*〕+ activity-registration.read.record)。
// - `org-supervisor`(分管推导用只读角色,BD-3 定稿 4 码;`activity.read.record` /
//   `attendance-record.read.record` 2 个候选码本刀不加,沿 §4.3 表末 🟡 维持未 seed)。
//
// **🔴 R5 安全红线:** 副职(vice-captain / dept-deputy / deputy-group-leader)**零** policy 行 ——
// 下方 POSITION_ROLE_POLICY_SEED 只登记 3 条正职映射,不为副职写任何行;`seedPositionRolePolicies`
// 末尾另有运行时断言兜底(防未来误改)。**这 3 角色本刀不指派给任何 user**(PR8 才据职务/分管动态推导),
// 不影响 RbacService.can() 判权语义;policy 表本身纯配置,绝不被任何判权路径读。
const ORG_ADMIN_ROLE_CODE = 'org-admin';
const ORG_ADMIN_DISPLAY_NAME = '组织业务管理员(队长/部长)';
const ORG_ADMIN_DESCRIPTION =
  '职务→角色 policy 默认映射目标(冻结稿 §3.7 BD-1):队长 team-leader / 部长 dept-leader 正职经 ' +
  'PositionRolePolicy 映射本角色,scope=TREE(任职组织,root 队长即覆盖全组织);≠ SUPER_ADMIN—— ' +
  '码集 = biz-admin 74 条过滤 attendance.final-approve.sheet / attendance.final-reject.sheet' +
  '(终审归 APD 类中枢显式 RoleBinding)/ recruitment-application.read.sensitive(敏感明文)/ ' +
  '整个 recruitment-*、team-join-* 前缀族(招新/入队中央流程,不随组织业务下放);不含任何平台/RBAC/' +
  '凭证码(biz-admin 本就不含);本刀零 user 持有,PR8 起由职务任职动态推导。';

const GROUP_MANAGER_ROLE_CODE = 'group-manager';
const GROUP_MANAGER_DISPLAY_NAME = '小组管理员(组长)';
const GROUP_MANAGER_DESCRIPTION =
  '职务→角色 policy 默认映射目标(冻结稿 §3.7):组长 group-leader 正职经 PositionRolePolicy 映射本角色,' +
  'scope=TREE(本组〔含子级〕)。码集 = 本组资料/内容/考勤一级读写(attachment.upload.*/view.* 10 条 + ' +
  'member-profile/certificate/emergency-contact 只读 3 条 + content.* 5 条 + attendance 一级 3 条 + ' +
  'activity-registration.read.record);不含 member 增删改/状态、attendance.final-*、*.read.sensitive、' +
  'activity 增删改/发布/取消、招新/入队/保险管理、content-image/content-file 附件写。本刀零 user 持有,' +
  'PR8 起由职务任职动态推导。';

const ORG_SUPERVISOR_ROLE_CODE = 'org-supervisor';
const ORG_SUPERVISOR_DISPLAY_NAME = '分管监督员(只读)';
const ORG_SUPERVISOR_DESCRIPTION =
  '分管(OrganizationSupervisionAssignment)推导用只读角色(冻结稿 §2.4 BD-3 定稿 4 码):' +
  'member.read.record / activity-registration.read.record / attendance.read.sheet / ' +
  'certificate.read.record。不含写 / 终审 / 敏感;分管人如需审批/终审须另加显式 RoleBinding。' +
  '`activity.read.record` / `attendance-record.read.record` 2 个候选码(§4.3 表末 🟡)本刀不加。' +
  '本刀零 user 持有,PR8 起由分管关系动态推导(不经本刀的 PositionRolePolicy——分管与职务正交)。';

// org-admin 排除项(冻结稿 §2.4 BD-1 + BD-2 + §4.2):终审 2 码 + 敏感 1 码,精确排除。
const ORG_ADMIN_EXCLUDED_CODES: ReadonlySet<string> = new Set([
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'recruitment-application.read.sensitive',
]);
// org-admin 排除项(runner 判断,goal 原文标注倾向排除):招新/入队中央功能码整前缀族。
const ORG_ADMIN_EXCLUDED_PREFIXES: ReadonlyArray<string> = ['recruitment-', 'team-join-'];

// org-admin 码集 = biz-admin 现绑码(74)过滤上述排除项;随 biz-admin 自动同步,不手工复制列表
// (biz-admin 未来若新增业务码,org-admin 自动继承,除非落入排除规则——与"队长/部长管本组织业务"语义一致)。
const ORG_ADMIN_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> =
  BIZ_ADMIN_PERMISSION_SEED.filter(
    (p) =>
      !ORG_ADMIN_EXCLUDED_CODES.has(p.code) &&
      !ORG_ADMIN_EXCLUDED_PREFIXES.some((prefix) => p.code.startsWith(prefix)),
  );

// group-manager 码集(冻结稿 §3.7 场景举例 + goal 本刀收敛;22 条)。
const GROUP_MANAGER_PERMISSION_CODES: ReadonlyArray<string> = [
  // attachment.upload.*/view.*(现有 20 码族中 member/certificate 的 self+other + activity;10 条;
  // 不含 content-image/content-file——那是 CMS 独立 "content-attachment" 码族,不在此通配范围)
  'attachment.upload.member.self',
  'attachment.upload.member.other',
  'attachment.upload.certificate.self',
  'attachment.upload.certificate.other',
  'attachment.upload.activity',
  'attachment.view.member.self',
  'attachment.view.member.other',
  'attachment.view.certificate.self',
  'attachment.view.certificate.other',
  'attachment.view.activity',
  // 本组队员资料只读(3 条)
  'member-profile.read.record',
  'certificate.read.record',
  'emergency-contact.read.record',
  // 内容管理(content.* 5 条;不含 content-image/content-file 附件写)
  'content.read.record',
  'content.create.record',
  'content.update.record',
  'content.delete.record',
  'content.publish.record',
  // 考勤一级审批(3 条;不含 final-*)
  'attendance.read.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  // 报名只读(1 条)
  'activity-registration.read.record',
];

// org-supervisor 码集(冻结稿 §2.4 BD-3 定稿;4 条,不含 2 个候选码)。
const ORG_SUPERVISOR_PERMISSION_CODES: ReadonlyArray<string> = [
  'member.read.record',
  'activity-registration.read.record',
  'attendance.read.sheet',
  'certificate.read.record',
];

// 默认职务→角色 policy(冻结稿 §3.7;**仅正职**,R5 副职不登记任何行)。scopeMode 全 TREE
// (相对任职组织;root 队长/部长 = 全组织,非 root = 本队/本部/本组)。
const POSITION_ROLE_POLICY_SEED: ReadonlyArray<{
  positionCode: string;
  roleCode: string;
  scopeMode: PolicyScopeMode;
}> = [
  { positionCode: 'team-leader', roleCode: ORG_ADMIN_ROLE_CODE, scopeMode: PolicyScopeMode.TREE },
  { positionCode: 'dept-leader', roleCode: ORG_ADMIN_ROLE_CODE, scopeMode: PolicyScopeMode.TREE },
  {
    positionCode: 'group-leader',
    roleCode: GROUP_MANAGER_ROLE_CODE,
    scopeMode: PolicyScopeMode.TREE,
  },
];

// R5 安全红线断言目标:副职职务 code(冻结稿 §3.7 🔴;这 3 个职务在本表必须恒为 0 行)。
const R5_VICE_POSITION_CODES: ReadonlyArray<string> = [
  'vice-captain',
  'dept-deputy',
  'deputy-group-leader',
];

// 依赖 seedPositions(职务 id)+ seedAttachmentPermissions(attachment.* 码)+ seedBizAdminRbac
// (biz-admin 码集,org-admin 借其过滤而来)均已完成,故放在 main() 最后一步。
// 幂等:RbacRole.upsert by code / RolePermission.upsert by (roleId,permissionId) /
// OrganizationPositionRolePolicy.upsert by (positionId,roleId)。
async function seedPositionRolePolicies(prisma: PrismaClient): Promise<void> {
  // 1. upsert 3 个管理/监督角色(本刀不绑定给任何 user)。
  const orgAdminRole = await prisma.rbacRole.upsert({
    where: { code: ORG_ADMIN_ROLE_CODE },
    update: {},
    create: {
      code: ORG_ADMIN_ROLE_CODE,
      displayName: ORG_ADMIN_DISPLAY_NAME,
      description: ORG_ADMIN_DESCRIPTION,
    },
    select: { id: true, code: true },
  });
  const groupManagerRole = await prisma.rbacRole.upsert({
    where: { code: GROUP_MANAGER_ROLE_CODE },
    update: {},
    create: {
      code: GROUP_MANAGER_ROLE_CODE,
      displayName: GROUP_MANAGER_DISPLAY_NAME,
      description: GROUP_MANAGER_DESCRIPTION,
    },
    select: { id: true, code: true },
  });
  const orgSupervisorRole = await prisma.rbacRole.upsert({
    where: { code: ORG_SUPERVISOR_ROLE_CODE },
    update: {},
    create: {
      code: ORG_SUPERVISOR_ROLE_CODE,
      displayName: ORG_SUPERVISOR_DISPLAY_NAME,
      description: ORG_SUPERVISOR_DESCRIPTION,
    },
    select: { id: true, code: true },
  });
  console.log(
    `[seed] RBAC roles '${orgAdminRole.code}' / '${groupManagerRole.code}' / ` +
      `'${orgSupervisorRole.code}' ensured`,
  );

  // 2. RolePermission 绑定(强校验:期望码数必须全部命中已 seed 的 Permission,否则说明调用顺序
  //    被打乱或码集拼写有误)。
  const bindRolePermissions = async (
    roleId: string,
    roleCode: string,
    codes: ReadonlyArray<string>,
  ): Promise<void> => {
    const perms = await prisma.permission.findMany({
      where: { code: { in: [...codes] } },
      select: { id: true, code: true },
    });
    if (perms.length !== codes.length) {
      const found = new Set(perms.map((p) => p.code));
      const missing = codes.filter((c) => !found.has(c));
      throw new Error(
        `[seed] PR7 seed 强校验失败:角色 '${roleCode}' 期望绑定 ${codes.length} 条 Permission,` +
          `实际查到 ${perms.length} 条;缺失:${missing.join(', ')}` +
          '(可能调用顺序早于 seedBizAdminRbac/seedAttachmentPermissions,或码集拼写有误)。',
      );
    }
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId: perm.id } },
        update: {},
        create: { roleId, permissionId: perm.id },
      });
    }
  };

  await bindRolePermissions(
    orgAdminRole.id,
    orgAdminRole.code,
    ORG_ADMIN_PERMISSION_SEED.map((p) => p.code),
  );
  await bindRolePermissions(
    groupManagerRole.id,
    groupManagerRole.code,
    GROUP_MANAGER_PERMISSION_CODES,
  );
  await bindRolePermissions(
    orgSupervisorRole.id,
    orgSupervisorRole.code,
    ORG_SUPERVISOR_PERMISSION_CODES,
  );
  console.log(
    `[seed] RBAC role-permissions ensured ('${orgAdminRole.code}' ↔ ` +
      `${ORG_ADMIN_PERMISSION_SEED.length} / '${groupManagerRole.code}' ↔ ` +
      `${GROUP_MANAGER_PERMISSION_CODES.length} / '${orgSupervisorRole.code}' ↔ ` +
      `${ORG_SUPERVISOR_PERMISSION_CODES.length})`,
  );

  // 3. upsert 默认 policy(仅正职;R5 副职不在 POSITION_ROLE_POLICY_SEED 中,本就不会写入)。
  const roleIdByCode = new Map<string, string>([
    [orgAdminRole.code, orgAdminRole.id],
    [groupManagerRole.code, groupManagerRole.id],
  ]);
  const positions = await prisma.organizationPosition.findMany({
    where: { code: { in: POSITION_ROLE_POLICY_SEED.map((p) => p.positionCode) } },
    select: { id: true, code: true },
  });
  const positionIdByCode = new Map(positions.map((p) => [p.code, p.id]));

  for (const policy of POSITION_ROLE_POLICY_SEED) {
    const positionId = positionIdByCode.get(policy.positionCode);
    const roleId = roleIdByCode.get(policy.roleCode);
    if (!positionId) {
      throw new Error(`[seed] PR7 policy 引用未知职务 code '${policy.positionCode}'`);
    }
    if (!roleId) {
      throw new Error(`[seed] PR7 policy 引用未知角色 code '${policy.roleCode}'`);
    }
    await prisma.organizationPositionRolePolicy.upsert({
      where: { positionId_roleId: { positionId, roleId } },
      update: {},
      create: { positionId, roleId, scopeMode: policy.scopeMode },
    });
  }
  console.log(
    `[seed] organization position role policies ensured (${POSITION_ROLE_POLICY_SEED.length} 条默认映射;仅正职,R5 副职零行)`,
  );

  // 4. R5 安全红线运行时断言(冻结稿 §3.7 🔴 / §10.5):副职必须零 policy 行,防未来任何改动
  //    误给副职塞入管理映射(总队 6 副队长各得近全组织管理 = goal 明禁的"部长=管理员")。
  const viceViolationCount = await prisma.organizationPositionRolePolicy.count({
    where: { position: { code: { in: [...R5_VICE_POSITION_CODES] } }, deletedAt: null },
  });
  if (viceViolationCount > 0) {
    throw new Error(
      `[seed] R5 安全红线破坏:副职(${R5_VICE_POSITION_CODES.join('/')})存在 ` +
        `${viceViolationCount} 条管理 policy 行,副职默认不得推导任何管理角色(冻结稿 §3.7 🔴 R5)。`,
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

    // V2 第一阶段:无论 SUPER_ADMIN 是否新建,都追加字典 seed
    await seedV2Dictionaries(prisma);

    // V2 第一阶段批次 3:activity_type 二级树字典(D11)
    await seedActivityTypeHierarchy(prisma);

    // 招新闭环优化 S1(2026-06-24):recruitment_stage 招新业务态文案字典(additive;7 态)
    await seedRecruitmentStageDict(prisma);

    // 组织树内置(2026-06-21 goal「组织树内置」):SRVF 根 + 15 部门。
    // 依赖 node_type 真实分类已由 seedV2Dictionaries 内置(nodeTypeCode 为字符串,无 FK,
    // 但语义上应在 node_type 之后)。
    await seedOrganizations(prisma);

    // 终态 scoped-authz PR3「职务定义」(2026-07-01;冻结稿 §3.2/§3.3):6 领导职务 + 30 默认职务规则。
    // 依赖 node_type 字典(seedV2Dictionaries 已内置)+ 本表 6 职务 id;规则 upsert 需先建职务。
    // 纯配置定义,不依赖 RBAC / Member / Organization 实例,故放 seedOrganizations 之后、seedRbac 之前。
    await seedPositions(prisma);
    await seedPositionRules(prisma);

    // V2.x C-6 RBAC 实施 PR #8(沿 D7 v1.1 §10):14 条 rbac.* + ops-admin + bootstrap
    await seedRbac(prisma);

    // V2.x C-7 attachments 实施 PR #6a(沿 D7-attachments v1.0 §6.1 / §10.3):
    //   20 条 attachment.* + member 内置角色 + 9 条 RolePermission 映射
    //   注:依赖 seedRbac 已完成(本函数自身只 upsert Permission / RbacRole / RolePermission,
    //   不依赖任何 ops-admin 状态;但放在 seedRbac 之后保持"先 RBAC meta 再业务权限点"语义顺序)
    await seedAttachmentPermissions(prisma);

    // CMS 内容模块(2026-06-21,评审稿 §5.1):content-image / content-file 附件类型默认配置行(幂等)
    await seedContentAttachmentTypeConfigs(prisma);

    // 统一通知 S2(2026-06-25,评审稿 §3.5):微信订阅模板配置默认行(templateId=null 待运营填;幂等)
    await seedWechatSubscribeTemplates(prisma);

    // Slow-4 T1(2026-06-11,评审稿 §5)36/35;保险模块 T1(2026-06-13,评审稿 §3.4)
    //   +7 全绑 → 43 条业务面权限码 + biz-admin 角色 + 42 条绑定
    //   + ADMIN 全员幂等补挂 + 强校验。放在 seedAttachmentPermissions 之后,
    //   保持"先 RBAC meta 再业务权限点"语义顺序;依赖 SUPER_ADMIN/ADMIN 用户已就位。
    await seedBizAdminRbac(prisma);

    // 终态 scoped-authz PR7「职务→角色 policy」(2026-07-01;冻结稿 §3.7):3 管理/监督角色 +
    //   绑定 + 3 条默认职务→角色映射(仅正职,R5 副职零行)。放在最后一步:依赖 seedPositions
    //   (职务 id)+ seedAttachmentPermissions(attachment.* 码)+ seedBizAdminRbac(biz-admin
    //   码集,org-admin 借其过滤而来)均已完成。
    await seedPositionRolePolicies(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// CMS 内容模块(2026-06-21;评审稿 §5.1 / §7):content-image / content-file 两 owner 的
// AttachmentTypeConfig 默认配置行(MIME 白名单 + 大小上限直接落 TypeConfig 默认列;v1 不开
// Mime/SizeLimit override 行,沿 attachment-config-boundary §6「新增 owner type = 新增一条
// AttachmentTypeConfig 行,不动 schema」)。幂等 upsert by code(update:{},不回退运营调整)。
const CONTENT_ATTACHMENT_TYPE_CONFIG_SEED = [
  {
    code: 'content-image',
    displayName: '内容图片(封面 / 正文图)',
    ownerTable: 'contents',
    defaultMaxSizeBytes: 10 * 1024 * 1024,
    defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp'],
  },
  {
    code: 'content-file',
    displayName: '内容文件附件',
    ownerTable: 'contents',
    defaultMaxSizeBytes: 20 * 1024 * 1024,
    defaultMimeWhitelist: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
] as const;

async function seedContentAttachmentTypeConfigs(prisma: PrismaClient): Promise<void> {
  for (const cfg of CONTENT_ATTACHMENT_TYPE_CONFIG_SEED) {
    await prisma.attachmentTypeConfig.upsert({
      where: { code: cfg.code },
      update: {},
      create: {
        code: cfg.code,
        displayName: cfg.displayName,
        ownerTable: cfg.ownerTable,
        defaultMaxSizeBytes: cfg.defaultMaxSizeBytes,
        defaultMimeWhitelist: [...cfg.defaultMimeWhitelist],
      },
    });
  }
  console.log(
    `[seed] content attachment type configs ensured (${CONTENT_ATTACHMENT_TYPE_CONFIG_SEED.length}: content-image / content-file)`,
  );
}

// 统一通知 S2(2026-06-25;微信订阅 quota 渠道,评审稿 §3.5 / D-N3):各 notification_type 的微信订阅模板
// 配置行(notificationTypeCode → templateId)。templateId **默认 null**(小程序后台审批后由 admin 经
// `PUT /api/admin/v1/notification-wechat-templates/:typeCode` 填,运营改不重部署);null = 该类型微信渠道
// 不可发(派发 skip),杜绝占位假模板误发真消息。幂等 upsert by notificationTypeCode,`update:{}` 不回退运营值。
const WECHAT_SUBSCRIBE_TEMPLATE_SEED = [
  'activity-reminder',
  'recruitment',
  'emergency',
  'general',
] as const;

async function seedWechatSubscribeTemplates(prisma: PrismaClient): Promise<void> {
  for (const notificationTypeCode of WECHAT_SUBSCRIBE_TEMPLATE_SEED) {
    await prisma.wechatSubscribeTemplate.upsert({
      where: { notificationTypeCode },
      update: {},
      create: { notificationTypeCode, templateId: null, enabled: true },
    });
  }
  console.log(
    `[seed] wechat subscribe templates ensured (${WECHAT_SUBSCRIBE_TEMPLATE_SEED.length}: templateId 默认 null 待运营配置)`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
