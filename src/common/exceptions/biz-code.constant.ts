import { HttpStatus } from '@nestjs/common';

// BizCode 常量表
//
// 当前状态(随实施滚动维护;每次新增模块码后校对):
// - 招新证书闭环刀A(2026-07-13):28xxx +2(28054 已审核通过禁止重传 / 28055 未审核通过禁止标门槛)
// - 389 个 BizCode(2026-08-05;当前总数以 docs/current-state.md §1 + `pnpm docs:counts:check` 真源为准)
// - 历史 2026-06-25 快照为 175 个 BizCode(彼时含 CMS content 290xx +5
//   + 活动闭环硬化 20123 报名截止 +1 + 统一通知 310xx +5;2026-06-13 的「141」系彼时快照,此后 realname 27xxx
//   + 招新·入队 28xxx(280xx/281xx/282xx)+ #399 review 错误码增量(13014 / 19010 / 30103)+ CMS content 290xx 5 码
//   + 20123 ACTIVITY_REGISTRATION_DEADLINE_PASSED〔201xx activities 段〕+ 通知 310xx 5 码),覆盖 25 个编号段
// - CMS 内容发布模块(第 28 模块,2026-06-21,评审稿 §7):290xx 段 5 码(29001 NOT_FOUND / 29010 type /
//   29011 visibility / 29012 visible-org / 29030 status-transition);291xx 权限边界预留(暂不用,RBAC 统一 30100);
//   附件类错误(MIME / 大小 / PII / owner)复用既有 13xxx,不新增码(评审稿 §7)
// - 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller,2026-06-25,评审稿 §9.3):310xx 段 5 码
//   (31001 NOT_FOUND / 31010 type / 31011 visibility / 31012 visible-org / 31030 status-transition,镜像 content 290xx);
//   311xx 权限边界预留(暂不用,RBAC 统一 30100);可见性复用 content.visibility,无第二套
// - 编号段权威说明以 `docs/srvf-foundation-baseline.md §1.1`
//   + `docs/reference/response-pagination-errors.md §5` 为准;
//   ARCHITECTURE 历史 v1 蓝图中的段位示例已随模块命名演进(missions→dictionaries、
//   files→attachments、devices→audit_logs 等),遇分歧以 baseline §1.1 + 本文件实际常量为准
// - 本文件是运行时代码唯一导出源(全仓 BizException throw 与 test 引用共 ~1700 处),
//   无明确迁移计划前不得拆分
//
// 治理约束:
// - 禁止复用已存在 code(新增前先 grep 数字是否撞段)
// - 禁止为同一语义新开重复码
//   (优先复用既有码;沿 docs/reference/soft-delete-transactions.md §10 信息泄漏防御)
// - 新增模块码必须先确认编号段归属(baseline §1.1 表)
// - 不在本文件记录接口路径(`GET /api/...` 之类语义留在 controller / docs / OpenAPI contract)
//
// 编号段索引(只读索引,以下方实际常量为准;每段位 200 个号段:XX0xx 普通业务 / XX1xx 权限边界):
// - 10xxx + 101xx: users + auth(含 P0-D 改密 / P0-E refresh token)
// - 11xxx + 111xx: organizations
// - 12xxx + 121xx: dictionaries(dict_type + dict_item 双子段)
// - 13xxx + 131xx: attachments + attachment-configs(三表)+ Slow-6 跨表 IN_USE + L-1 system MIME 黑名单
// - 14xxx + 141xx: audit_logs(写入不可改不可删,故仅 14001 / 14101)
// - 15xxx + 151xx: members
// - 16xxx + 161xx: member_profiles
// - 17xxx + 171xx: member_departments
// - 18xxx + 181xx: certificates
// - 19xxx + 191xx: emergency_contacts
// - 20xxx + 201xx: activities
// - 21xxx + 211xx: activity_registrations
// - 22xxx + 221xx: attendances(批次 3B + 4-A APD 终审)
// - 23xxx + 231xx: contribution_rules
// - 25xxx + 251xx: wechat(微信小程序登录,2026-06-12)
// - 26xxx + 261xx: insurances(保险模块,2026-06-13)
// - 27xxx: realname(实名核验通道,2026-06-18;27030/27031 通道错误)
// - 28xxx + 281xx + 282xx: recruitment 一/二期 + team-join 入队(招新业务域,2026-06-18/19)
// - 29xxx + 291xx: content(CMS 内容发布,2026-06-21;290xx 5 码,291xx 预留)
// - 30xxx + 301xx: permissions(C-6 RBAC)
// - 31xxx + 311xx: notifications(统一通知模块 S1 站内信渠道,2026-06-25;310xx 5 码,311xx 预留)
// - 32xxx: organization positions + position rules + position assignments(职务定义 320xx 3 码 + 职务规则 3201x 3 码 + 任职 3202x 8 码;终态 scoped-authz PR3/PR4,2026-07-01)
// - 33xxx: organization supervision assignments(分管关系 330xx 4 码;终态 scoped-authz PR5,2026-07-01)
// - 34xxx: role bindings(角色绑定 340xx 5 码;终态 scoped-authz PR6,2026-07-01)
// - 35xxx: activity feedbacks(活动评价 350xx 4 码;2026-07-16)
// - 40xxx / 42xxx / 50xxx: 通用 HTTP / infrastructure(BAD_REQUEST / UNAUTHORIZED / FORBIDDEN / NOT_FOUND / TOO_MANY_REQUESTS / INTERNAL_ERROR)
// - 未规划模块预留(训练 / 装备 / 财务等):35xxx 之后顺延(realname 27xxx / recruitment 28xxx / content 29xxx / notification 31xxx / position 32xxx / supervision 33xxx / role-binding 34xxx / feedback 35xxx 已实装)
export const BizCode = {
  // 通用 HTTP 级
  BAD_REQUEST: { code: 40000, message: '请求参数错误', httpStatus: HttpStatus.BAD_REQUEST },
  UNAUTHORIZED: { code: 40100, message: '未登录或登录已失效', httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN: { code: 40300, message: '无权限访问', httpStatus: HttpStatus.FORBIDDEN },
  NOT_FOUND: { code: 40400, message: '资源不存在', httpStatus: HttpStatus.NOT_FOUND },
  // docs/reference/response-pagination-errors.md §5:登录接口限流命中。
  // 落 4xxxx 通用 HTTP 段(429),
  // 不占用业务模块 100xx / 110xx 段。message 故意不暴露阈值数字、剩余配额、
  // 重置时间(防止攻击者反推限流参数)。
  TOO_MANY_REQUESTS: {
    code: 42900,
    message: '请求过于频繁，请稍后再试',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
  },
  // M3(并发复审 P1,2026-08-01):有界锁等待。
  // 此前所有锁等待都是**无界**的:一直等到 Prisma 默认 5s 交互事务预算耗尽 → P2028 →
  // 全局过滤器映射 50000「服务器内部错误」。那既不是事实(服务器没坏,只是有人在排队),
  // 也不可重试(500 语义上不该重试),排查时还看不出是并发。
  // 现在 `withBoundedMemberLockWait` 给这些事务设 `SET LOCAL lock_timeout`,
  // 超时以 PostgreSQL 55P03 干净失败,统一映射到本码。
  // 号位:40900 留给未来的通用 CONFLICT,本码取 40901。
  CONCURRENT_WRITE_LOCK_TIMEOUT: {
    code: 40901,
    message: '该数据正被其他操作占用,请稍后重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 万人锁原型收口(#906 §5.1,2026-08-04):PostgreSQL 40P01 = deadlock_detected。
  //
  // 此前 40P01 不在 `withBoundedMemberLockWait` 的翻译范围内(那里只翻 55P03),
  // 会以未映射错误冒出去 → 50000「服务器内部错误」。那是 M3 给 55P03 修掉的同一个毛病
  // 从另一条路回来:数据库**主动中止**了环上的一个事务,该请求原样重发就会成功,
  // 却拿到一个语义上不该重试的 500。
  //
  // 为什么**不**并进 40901:两者对运维是相反的信号。40901「有人排在你前面」是负载信号;
  // 40P01「取锁成环」是**代码的锁序缺陷**信号。归一成一个码等于用可诊断性换少一个常量 ——
  // 真出锁序回归时,它会伪装成一次普通拥塞。号位取 40901 之后的 40902。
  //
  // ⚠️ 翻译**不是**给锁序问题兜底:批内定序仍由
  // `test/e2e/member-advisory-lock-order.e2e-spec.ts` ① 硬顶(判据是「零死锁」),
  // 本码只负责让**批间交叉**这类真实残留死得体面。
  CONCURRENT_WRITE_DEADLOCK: {
    code: 40902,
    message: '并发写入相互占用,请重试该操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  INTERNAL_ERROR: {
    code: 50000,
    message: '服务器内部错误',
    httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
  },

  // users 模块业务级(100xx)—— 实际 throw 点在第 7/8 阶段落地
  USER_NOT_FOUND: { code: 10001, message: '用户不存在', httpStatus: HttpStatus.NOT_FOUND },
  USERNAME_ALREADY_EXISTS: {
    code: 10002,
    message: 'username 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  EMAIL_ALREADY_EXISTS: {
    code: 10003,
    message: 'email 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  LOGIN_FAILED: {
    code: 10004,
    message: '账号或密码错误',
    httpStatus: HttpStatus.UNAUTHORIZED,
  },

  // P0-D 本人自助改密(2026-05-17 引入;详见 docs/first-release-p0d-change-my-password-review.md §5.3)。
  // 段位归属:沿 100xx users 模块业务级;10005 / 10006 为 LOGIN_FAILED(10004)之后下两个可用号位。
  // - 10005 OLD_PASSWORD_INVALID:本人改密 oldPassword 错(本人接口,无账号枚举攻击面,
  //   不复用 LOGIN_FAILED;前端可精确提示"当前密码不正确")
  // - 10006 NEW_PASSWORD_SAME_AS_OLD:newPassword === oldPassword(业务级语义校验,不复用 BAD_REQUEST)
  OLD_PASSWORD_INVALID: {
    code: 10005,
    message: '当前密码不正确',
    httpStatus: HttpStatus.UNAUTHORIZED,
  },
  NEW_PASSWORD_SAME_AS_OLD: {
    code: 10006,
    message: '新密码不能与当前密码相同',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // P0-E PR-3(2026-05-18):refresh token 接口失败统一码(沿
  // docs/first-release-p0e-refresh-token-review.md §5.7 + §6.5)。
  // 段位归属:沿 docs/reference/response-pagination-errors.md §5 BizCode 编码段:
  // 100xx 为 users 模块业务级(含 auth);
  // 已用 10001-10006(LOGIN_FAILED=10004 / OLD_PASSWORD_INVALID=10005 /
  // NEW_PASSWORD_SAME_AS_OLD=10006),10007 为下一可用号位。
  //
  // **不**拆 REFRESH_TOKEN_EXPIRED / REVOKED / REPLAY
  // (沿评审稿 D-6 + docs/reference/auth-jwt-refresh.md §8 防账号枚举):
  // refresh 失败的 4 种子原因(不存在 / 已撤销 / 已过期 / 重放命中)统一返 10007,
  // 响应体 / HTTP status / message 完全一致(防止攻击者据错误码反推 token 状态)。
  REFRESH_TOKEN_INVALID: {
    code: 10007,
    message: 'refresh token 无效或已过期',
    httpStatus: HttpStatus.UNAUTHORIZED,
  },
  STEP_UP_PROOF_INVALID: {
    code: 10008,
    message: 'step-up proof 无效或已过期',
    httpStatus: HttpStatus.UNAUTHORIZED,
  },
  STEP_UP_FACTOR_UNAVAILABLE: {
    code: 10009,
    message: '当前账号未绑定该验证因子',
    httpStatus: HttpStatus.CONFLICT,
  },

  // users 模块权限/操作边界(101xx)
  FORBIDDEN_ROLE_OPERATION: {
    code: 10101,
    message: '无权对该用户执行此操作',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  CANNOT_OPERATE_SELF: {
    code: 10102,
    message: '不能对自己执行此操作',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  LAST_SUPER_ADMIN_PROTECTED: {
    code: 10103,
    message: '系统必须保留至少一个活跃超级管理员',
    httpStatus: HttpStatus.CONFLICT,
  },

  // member_departments / memberships 模块业务级(170xx + 171xx;同"组织归属"域)。详见 docs/v2-api-contract.md §5.4。
  // 子段(对齐 baseline §1.3):
  // - 17001:NOT_FOUND(member 当前无 active 归属;旧 department 端点)
  // - 17002:唯一约束冲突(并发兜底,partial unique index 撞;旧 department 端点)
  // - 17003:NOT_FOUND(memberships :id 端点:该归属不存在 / 非本人 / 已软删;终态 scoped-authz PR2)
  // - 17004:唯一约束冲突(PRIMARY 唯一 / (member,org,type) 唯一撞;P2002 兜底;终态 scoped-authz PR2)
  // - 17030-17099:资源状态非法(member INACTIVE / organization INACTIVE)
  //
  // 复用现有错误码:MEMBER_NOT_FOUND(15001) / ORGANIZATION_NOT_FOUND(11001);
  // 不登记 FORBIDDEN_MANAGE_MEMBER_DEPARTMENT(沿用 dict/org/members 决策)。
  MEMBER_DEPARTMENT_NOT_FOUND: {
    code: 17001,
    message: '队员当前无部门归属',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBER_DEPARTMENT_ALREADY_EXISTS: {
    code: 17002,
    message: '队员已有活跃部门归属',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1 / §7.1):memberships 归属 CRUD 业务码。
  // NOT_FOUND 为 :id 端点(PATCH/DELETE)必需的兜底;ALREADY_EXISTS 承接 P2002(两 partial unique 任一撞)。
  MEMBERSHIP_NOT_FOUND: {
    code: 17003,
    message: '归属记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBERSHIP_ALREADY_EXISTS: {
    code: 17004,
    message: '该归属已存在(主归属唯一 / 同组织同类型不可重复)',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_INACTIVE: {
    code: 17030,
    message: '队员状态非活跃,不能挂部门',
    httpStatus: HttpStatus.CONFLICT,
  },
  ORGANIZATION_INACTIVE: {
    code: 17031,
    message: '组织节点状态非活跃,不能挂队员',
    httpStatus: HttpStatus.CONFLICT,
  },

  // member_profiles 模块业务级(160xx + 161xx)。批次 1 引入。
  // 子段(对齐 baseline §1.3):
  // - 16001:NOT_FOUND
  // - 16002-16009:唯一约束冲突(memberId 1:1)
  // - 16010-16029:业务级输入校验(各字典字段 invalid)
  //
  // 字典字段无效不收敛为单一码:沿用 members 模块每字典字段一码模式(详见 batch-1
  // API 前评审 §9.5)。保留 161xx 给后续 USER 自助路由 / 二次校验等权限边界码。
  MEMBER_PROFILE_NOT_FOUND: {
    code: 16001,
    message: '队员档案不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBER_PROFILE_ALREADY_EXISTS: {
    code: 16002,
    message: '队员档案已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_PROFILE_GENDER_CODE_INVALID: {
    code: 16010,
    message: '性别字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID: {
    code: 16011,
    message: '证件类型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_POLITICAL_STATUS_CODE_INVALID: {
    code: 16012,
    message: '政治面貌字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID: {
    code: 16013,
    message: '血型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_PROFILE_WORK_NATURE_CODE_INVALID: {
    code: 16014,
    message: '工作性质字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // emergency_contacts 模块业务级(190xx + 191xx)。批次 1 引入。
  // baseline §1.1 原预留 events / event_participants;批次 1 启动时 emergency_contacts
  // 单独成模块,占用 190xx;baseline 同步追加一行(member_profiles 仍占 baseline 预留 160xx)。
  // 子段:
  // - 19001:NOT_FOUND
  // - 19010-19029:业务级输入校验(relation_code_invalid)
  // - 19101:权限边界(NOT_BELONGS_TO_MEMBER)
  EMERGENCY_CONTACT_NOT_FOUND: {
    code: 19001,
    message: '紧急联系人不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  EMERGENCY_CONTACT_RELATION_CODE_INVALID: {
    code: 19010,
    message: '紧急联系人关系字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER: {
    code: 19101,
    message: '紧急联系人不属于该队员',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // certificates 模块业务级(180xx + 181xx)。批次 2 引入(2026-05-10)。
  // 段位选择:baseline §1.1 中 180xx 是 batch 1 评审时为 member_profiles 预留但实际让位
  // 160xx 后空出的段位;批次 2 接管。详见 docs:批次2_API前评审_certificates.md §9。
  // 子段(对齐 baseline §1.3;证书标准库 PR-3 起 NOT_FOUND 扩到三条):
  // - 18001 / 18002 / 18004:NOT_FOUND(证书实例 / 证书标准 / 认定规则)
  // - 18003:唯一约束冲突(Standard code)
  // - 18010-18029:业务级输入校验(字典 invalid、日期语义、Standard kind / 父级 / 机构 / 有效期配置)
  // - 18030-18099:资源状态非法 / 状态机转移非法 / 并发冲突兜底
  // - 18101:权限边界(NOT_BELONGS_TO_MEMBER)
  //
  // 复用现有错误码:MEMBER_NOT_FOUND(15001);
  // 不开 CERTIFICATE_STATUS_CODE_INVALID(DTO 不接收,service 写常量,无外部传入路径);
  // 不开 P2002 相关码(本批次 schema 无业务唯一约束,草案 §11.2)。
  CERTIFICATE_NOT_FOUND: {
    code: 18001,
    message: '证书不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  CERTIFICATE_TYPE_CODE_INVALID: {
    code: 18010,
    message: '证书大类字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_SUB_TYPE_CODE_INVALID: {
    code: 18011,
    message: '证书子类型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 证书标准库 PR-1(冻结稿 §10.3 基础校验 + §18 号位建议)。
  // 落在既有 18010-18029「业务级输入校验」子段;号位已 grep 真源确认无碰撞
  // (180xx 现用 18001/18010/18011/18030/18101)。
  CERTIFICATE_DATE_RANGE_INVALID: {
    code: 18017,
    message: '到期日期不能早于发证日期',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_ISSUED_AT_IN_FUTURE: {
    code: 18018,
    message: '发证日期不能晚于今天',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_INVALID_STATE_TRANSITION: {
    code: 18030,
    message: '证书状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_NOT_BELONGS_TO_MEMBER: {
    code: 18101,
    message: '证书不属于该队员',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // ===== 证书标准库 PR-3(冻结稿 §18)=====
  //
  // 号位落在既有子段:18002/18004 = NOT_FOUND;18012-18019 = 业务级输入校验;
  // 18031-18040 = 资源状态非法 / 状态机转移非法。
  // 已 grep 真源确认无碰撞(180xx 此前占用 18001/18010/18011/18017/18018/18030/18101)。
  // §18 的号码是「建议」,本刀按真源逐条复核后落定;18014/18016/18035/18038
  // 属实例写路径(建证与审核),留给 PR-4a,此刻加就是孤码。
  CERTIFICATE_STANDARD_NOT_FOUND: {
    code: 18002,
    message: '证书标准不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  CERTIFICATE_STANDARD_CODE_EXISTS: {
    code: 18003,
    message: '证书标准编码已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_POLICY_NOT_FOUND: {
    code: 18004,
    message: '证书认定规则不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  CERTIFICATE_STANDARD_KIND_INVALID: {
    code: 18012,
    message: '该目录节点不是可持有证书标准',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_ISSUER_CONFIG_INVALID: {
    code: 18013,
    message: '发证机构配置不符合认定规则',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_VALIDITY_INVALID: {
    code: 18015,
    message: '证书有效期不符合认定规则',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // §5.2 的父级约束三合一:父节点必须是 FAMILY 由 18012 表达;
  // 「父子 categoryCode 不一致」与「形成父子循环」用本码(§18 建议表未列,按真源补)。
  CERTIFICATE_STANDARD_PARENT_INVALID: {
    code: 18019,
    message: '父级证书标准不合法(类别不一致或形成循环)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // ===== 证书标准库 PR-4a-1:实例写路径码(PR-3 刻意延后的那批)=====
  // PR-3 不加这几条是因为当时没有消费者 —— 建证与审核路径在本刀才切到
  // Standard/Policy,此刻它们才有真实触发点(§18 号位 18014/18016/18035)。
  CERTIFICATE_ISSUER_NOT_ALLOWED: {
    code: 18014,
    message: '发证机构不在认可范围内',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_NUMBER_REQUIRED: {
    code: 18016,
    message: '该证书必须填写证书编号',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // §5.3 certNumberMode=NONE:「必须为 NULL;客户端传值直接拒绝」。
  // 刻意不静默丢弃 —— 静默丢弃会让运营以为编号已存下来。
  // §18 建议表未列本码,按真源补(18020,18010-18029 校验子段内空闲)。
  CERTIFICATE_NUMBER_NOT_ALLOWED: {
    code: 18020,
    message: '该证书的认定规则不接受证书编号',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CERTIFICATE_ACTIVE_POLICY_MISSING: {
    code: 18035,
    message: '该证书标准尚无生效认定规则',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_STANDARD_INACTIVE: {
    code: 18031,
    message: '证书标准未启用',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_STANDARD_IN_USE: {
    code: 18032,
    message: '证书标准已被引用,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_STANDARD_IMMUTABLE: {
    code: 18033,
    message: '证书标准启用后身份字段不可修改',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_STANDARD_STATE_INVALID: {
    code: 18034,
    message: '证书标准状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_POLICY_IMMUTABLE: {
    code: 18036,
    message: '生效或退役认定规则不可修改',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_POLICY_STATE_INVALID: {
    code: 18037,
    message: '认定规则状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 两条并发兜底码。都由 P2002 转来,但撞的是**不同索引**,语义与前端提示不同,
  // 故分开(§5.3 要求「显式转换 P2002」,按 meta.target 里的索引名区分):
  // - (standardId, version) 普通唯一 → 版本号被别人抢先占用,重取 MAX(version) 再来
  // - one_active_per_standard partial unique → 已有别的版本刚被激活,刷新后再决定
  CERTIFICATE_POLICY_VERSION_CONFLICT: {
    code: 18039,
    message: '认定规则版本号已被占用,请刷新后重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  CERTIFICATE_POLICY_ACTIVE_CONFLICT: {
    code: 18040,
    message: '该证书标准已有生效认定规则,请刷新后重试',
    httpStatus: HttpStatus.CONFLICT,
  },

  // members 模块业务级(150xx + 151xx)。详见 docs/v2-api-contract.md §4.7。
  // 子段(对齐 baseline §1.3):
  // - 15001:NOT_FOUND
  // - 15002-15009:唯一约束冲突(memberNo)
  // - 15010-15029:业务级输入校验(grade_code_invalid)
  // - 15030-15099:资源状态非法 / 引用约束(has_active_department / has_linked_user)
  //
  // 注:登录账号枚举相关失败场景(memberNo 路径未命中 / 命中但未绑 user 等)
  // 统一抛 v1 LOGIN_FAILED = 10004,**禁止**在 150xx 段为 memberNo 路径自创业务码。
  MEMBER_NOT_FOUND: {
    code: 15001,
    message: '队员不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  MEMBER_NO_ALREADY_EXISTS: {
    code: 15002,
    message: '队员编号已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_GRADE_CODE_INVALID: {
    code: 15010,
    message: '队员等级字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_HAS_ACTIVE_DEPARTMENT: {
    code: 15030,
    message: '队员仍有部门归属,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_HAS_LINKED_USER: {
    code: 15031,
    message: '队员已被 user 绑定,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 队员账号闭环 v2(评审稿 docs/archive/reviews/member-account-loop-v2-review.md §3.3):
  // bind/unbind/reopen/status 四端点新增 2 码,延续 15030-15099"资源状态非法/引用约束"子段。
  MEMBER_ACCOUNT_TARGET_ALREADY_LINKED: {
    code: 15032,
    message: '目标账号已绑定其他队员',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_HAS_NO_LINKED_USER: {
    code: 15033,
    message: '队员当前无绑定账号',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 第三轮全仓 review 护栏收口(docs/archive/reviews/full-repo-first-principles-adversarial-review-v0.38.0.md
  // §F&A-1/A-4):队员轴账号端点只管理 role=USER 的普通账号,防止把特权账号(ADMIN/SUPER_ADMIN)
  // 经队员轴绕过用户轴 assertNotLastSuperAdmin + assertCanManageUser 两道护栏。新增 3 码,
  // 延续 15030-15099"资源状态非法/引用约束"子段。
  MEMBER_ACCOUNT_TARGET_ROLE_NOT_ALLOWED: {
    code: 15034,
    message: '目标账号不是普通用户,不能绑定为队员账号',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_ACCOUNT_TARGET_NOT_ACTIVE: {
    code: 15035,
    message: '目标账号未启用,不能绑定',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE: {
    code: 15036,
    message: '关联账号不是普通用户,请通过用户管理端点操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  // PR-F 离队影响预检：责任移交与未来报名清理由 impact endpoint 给出完整安全摘要；
  // offboard 只返回稳定冲突码，避免在异常体泄露活动明细。
  MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED: {
    code: 15037,
    message: '队员仍有活动责任,请先完成移交',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_OFFBOARD_REGISTRATION_CLEANUP_REQUIRED: {
    code: 15038,
    message: '队员仍有当前或未来活动报名,请先完成清理',
    httpStatus: HttpStatus.CONFLICT,
  },

  // organizations 模块业务级(110xx + 111xx)。详见 docs/v2-api-contract.md §3.5。
  // 子段(对齐 baseline §1.3):
  // - 11001:NOT_FOUND
  // - 11010-11029:业务级输入校验(parent_not_found / node_type_invalid /
  //   parent_cycle / parent_change_forbidden)
  // - 11030-11099:资源状态非法 / 引用约束(has_children / has_members /
  //   root_already_exists / code_already_exists)
  // - 11103:系统约束保护(last_root_protected)
  ORGANIZATION_NOT_FOUND: {
    code: 11001,
    message: '组织节点不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ORGANIZATION_PARENT_NOT_FOUND: {
    code: 11010,
    message: '父级组织节点不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ORGANIZATION_NODE_TYPE_INVALID: {
    code: 11011,
    message: '节点类别字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ORGANIZATION_PARENT_CYCLE: {
    code: 11012,
    message: '组织节点父级形成环',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ORGANIZATION_PARENT_CHANGE_FORBIDDEN: {
    code: 11013,
    message: '不允许修改组织节点父级',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ORGANIZATION_HAS_CHILDREN: {
    code: 11030,
    message: '组织节点存在子节点,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  ORGANIZATION_HAS_MEMBERS: {
    code: 11031,
    message: '组织节点存在成员归属,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  ORGANIZATION_ROOT_ALREADY_EXISTS: {
    code: 11032,
    message: '系统已存在活跃根节点',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 组织缩写 code 撞唯一约束(含软删历史占用;Service findUnique 预检查 + P2002 兜底)。
  ORGANIZATION_CODE_ALREADY_EXISTS: {
    code: 11033,
    message: '组织缩写 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  LAST_ROOT_ORGANIZATION_PROTECTED: {
    code: 11103,
    message: '系统必须保留至少一个活跃根节点',
    httpStatus: HttpStatus.CONFLICT,
  },

  // dictionaries 模块业务级(120xx + 121xx;dict_type 用 12001-12009 / 12030-12039,
  // dict_item 用 12010-12019 / 12031-12049)。详见 docs/v2-api-contract.md §2.5。
  DICT_TYPE_NOT_FOUND: {
    code: 12001,
    message: '字典类型不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  DICT_TYPE_CODE_ALREADY_EXISTS: {
    code: 12002,
    message: '字典类型 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 系统内置字典类型禁止软删(seed 内置类型;额外闸,与 DICT_TYPE_IN_USE 并存,
  // 不依赖当前是否被引用)。详见 dictionaries.service.ts SYSTEM_PROTECTED_DICT_TYPES。
  DICT_TYPE_SYSTEM_PROTECTED: {
    code: 12003,
    message: '系统内置字典类型不允许删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_ITEM_NOT_FOUND: {
    code: 12010,
    message: '字典项不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  DICT_ITEM_CODE_ALREADY_EXISTS: {
    code: 12011,
    message: '同类型下字典项 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_ITEM_PARENT_TYPE_MISMATCH: {
    code: 12012,
    message: '字典项父级跨类型',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  DICT_ITEM_PARENT_CYCLE: {
    code: 12013,
    message: '字典项父级形成环',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 规划保留未实装(2026-06-12 把关亲核:全仓零 throw 点;不删码、不改码值,沿 22042/22044
  // "不开的码"登记范式)。原计划(docs/archive/plans/first-release-bizcode-mapping.md 12014 行)
  // 拦截 PATCH item 透传 parentId;现实装 UpdateDictItemDto 仅收 label / sortOrder,
  // parentId 不在白名单(违规入参由全局 forbidNonWhitelisted 422 承接),本码无触发路径;
  // 若未来开放父级编辑再实装启用。
  DICT_ITEM_PARENT_IMMUTABLE: {
    code: 12014,
    message: '字典项父级不允许修改',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 系统内置字典项禁止软删(闭集 + 国标参照 + 队内内置类型下的项;额外闸,与 DICT_ITEM_IN_USE 并存,
  // 不依赖当前是否被引用)。详见 dictionaries.service.ts ITEM_PROTECTED_DICT_TYPES。
  DICT_ITEM_SYSTEM_PROTECTED: {
    code: 12015,
    message: '系统内置字典项不允许删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_TYPE_IN_USE: {
    code: 12030,
    message: '字典类型仍有项目引用,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  DICT_ITEM_IN_USE: {
    code: 12031,
    message: '字典项仍被业务表引用,不能删除',
    httpStatus: HttpStatus.CONFLICT,
  },

  // activities 模块业务级(200xx + 201xx)。批次 3A 引入(2026-05-11)。
  // 详见 docs:批次3_API前评审决议表.md v1.0 §1.7-1.12 + §6.1。
  // 段位选择:沿 baseline §1.1 预留 200xx 段给 activities。
  // 子段(对齐 baseline §1.3):
  // - 20001-20009:NOT_FOUND / 唯一冲突
  // - 20010-20019:业务级输入校验(根节点 / 字典 / capacity / 起止时间)
  // - 20030-20099:资源状态非法 / 状态机转移非法 / cancelled 拒改(Q-A12)
  // - 20120-20129:跨资源约束(报名时 Activity 状态 / isPublicRegistration 校验)
  //
  // 复用现有错误码:ORGANIZATION_NOT_FOUND(11001)— update 传入不存在 organizationId 时复用。
  // 不开 FORBIDDEN_ACTIVITY_PUBLISH / FORBIDDEN_ACTIVITY_CANCEL:沿 baseline 决策,
  // Guard 拒绝走通用 FORBIDDEN(40300),不为单接口开 FORBIDDEN_* 业务码。
  ACTIVITY_NOT_FOUND: {
    code: 20001,
    message: '活动不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_POSITION_NOT_FOUND: {
    code: 20002,
    message: '活动岗位不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_POSITION_NAME_ALREADY_EXISTS: {
    code: 20003,
    message: '同一活动已存在同名岗位',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PUBLISH_REVIEW_NOT_FOUND: {
    code: 20004,
    message: '活动发布审核记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_RESPONSIBILITY_NOT_FOUND: {
    code: 20005,
    message: '活动责任记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN: {
    code: 20011,
    message: '活动不允许挂在组织根节点',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_TYPE_CODE_INVALID: {
    code: 20012,
    message: '活动类型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID: {
    code: 20013,
    message: '活动性别要求字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 规划保留未实装(2026-06-12 把关亲核:全仓零 throw 点;不删码、不改码值,沿 22042/22044
  // "不开的码"登记范式)。原计划(docs/archive/plans/first-release-bizcode-mapping.md 20014 行)
  // 拦截 capacity 组合非法(例:min > max);现实装 capacity 为单一可空 Int(NULL = 不限名额),
  // 数值校验由 DTO @IsInt + @Min(1) 承接,无"组合非法"场景,本码无触发路径;实装时直接启用。
  ACTIVITY_CAPACITY_INVALID: {
    code: 20014,
    message: '活动名额配置无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_START_END_INVALID: {
    code: 20015,
    message: '活动起止时间无效(startAt 必须早于 endAt)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_REGISTRATION_DEADLINE_INVALID: {
    code: 20016,
    message: '报名截止时间不得晚于活动结束时间',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_POSITION_TIME_RANGE_INVALID: {
    code: 20017,
    message: '活动岗位时间范围无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_POSITION_CAPACITY_INVALID: {
    code: 20018,
    message: '活动岗位名额配置无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_INITIATOR_NOT_FORMAL: {
    code: 20019,
    message: '只有正式队员可以发起活动',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  ACTIVITY_INITIATION_ORG_FORBIDDEN: {
    code: 20020,
    message: '无权为该组织发起活动',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  ACTIVITY_PUBLISH_REVIEW_NOTE_REQUIRED: {
    code: 20021,
    message: '退回发布审核必须填写原因',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID: {
    code: 20022,
    message: '活动审核快照无效或已过期',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_STATUS_INVALID: {
    code: 20030,
    message: '活动当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS: {
    code: 20031,
    message: '活动岗位仍有活跃报名,不可删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PUBLISH_REVIEW_PENDING: {
    code: 20032,
    message: '活动已有待处理的发布审核',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID: {
    code: 20033,
    message: '发布审核当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS: {
    code: 20034,
    message: '该人员已承担此活动责任',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_RESPONSIBILITY_TARGET_INVALID: {
    code: 20035,
    message: '责任人或协办人不符合条件',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_CHANGE_REVIEW_REQUIRED: {
    code: 20037,
    message: '已发布活动修改需先提交审核',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_LEGACY_OWNER_REQUIRED: {
    code: 20038,
    message: '历史活动尚未指定负责人',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_ATTENDANCE_DECLARATION_INVALID: {
    code: 20039,
    message: '当前活动不能声明考勤已全部提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_NOT_PUBLIC_REGISTRATION: {
    code: 20120,
    message: '活动未开放报名',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN: {
    code: 20121,
    message: '活动已取消,禁止报名',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 批次 3B 补充(2026-05-11):activities 段 20122,attendances 提交时校验活动状态。
  ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN: {
    code: 20122,
    message: '活动已取消,禁止录入考勤',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 活动闭环硬化(2026-06-21):报名截止时刻生效。registrationDeadline 非 null 且 now > deadline →
  // 拒报名;自助 createMy + 管理员代报名 create 两路经 assertActivityRegistrable 共用此闸
  // (App createMyForApp 薄壳经 createMy 同样拦)。approve 不加闸:截止只管报名动作,不管事后审批,
  // 截止前已报的 pending 仍可批。沿 20120/20121 报名时活动态阻断家族,409。
  ACTIVITY_REGISTRATION_DEADLINE_PASSED: {
    code: 20123,
    message: '活动报名已截止',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 参与域生命周期收口①(v0.40.0):approve 时活动状态闸。活动 statusCode ∈ {cancelled, completed}
  // → 报名不可审批通过(reject / cancel 刻意不拦:留作清理已取消/已完结活动残留待审队列的唯一手段)。
  // 沿 20120/20121 报名时活动态阻断家族,409。
  ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN: {
    code: 20124,
    message: '活动已取消或已完结,报名不可审批通过',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 参与域生命周期收口③(v0.40.0):活动已结束(now > endAt)→ 不可报名。两路公共闸
  // assertActivityRegistrable(create 代报名 + createMy 自助,App createMyForApp 薄壳经此)在
  // registrationDeadline 闸之后追加此闸;精确时刻比较,不做北京日归一。沿 20120/20121/20123
  // 报名时活动态阻断家族,409。
  ACTIVITY_ENDED_REGISTRATION_FORBIDDEN: {
    code: 20125,
    message: '活动已结束,不可报名',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN: {
    code: 20126,
    message: '活动未发布,不可报名、审批或提交考勤',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN: {
    code: 20127,
    message: '活动已有报名或考勤记录,请先取消活动',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第一刀:证据封场(合同 §5.8)=====
  //
  // 合同 §5.8 末句:「seal 不是"负责人承诺",没有所有条件不能写」。
  // ⇒ **每一条拒绝理由一个具名码**,而不是笼统一个 ACTIVITY_STATUS_INVALID —— 否则
  //    前端与运维只知道"封不了",不知道差哪一项,机器判定就退化回人工排查。
  // 落 200xx 段 20040-20046(20001-20039 已用,与 201xx 报名态阻断家族分开)。
  // 全部 409:每一条都是"当前状态不允许",不是入参错。
  EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN: {
    code: 20040,
    message: '仍有场次的签退窗口未结束,不可封场',
    httpStatus: HttpStatus.CONFLICT,
  },
  EVIDENCE_SEAL_OPEN_SEGMENT_EXISTS: {
    code: 20041,
    message: '仍有未闭合的服务段,不可封场',
    httpStatus: HttpStatus.CONFLICT,
  },
  EVIDENCE_SEAL_MANUAL_REVIEW_PENDING: {
    code: 20042,
    message: '仍有待人工复核项,不可封场',
    httpStatus: HttpStatus.CONFLICT,
  },
  EVIDENCE_SEAL_UNPROCESSED_EVENT_EFFECT: {
    code: 20043,
    message: '仍有未投影到服务段的打卡事件,不可封场',
    httpStatus: HttpStatus.CONFLICT,
  },
  EVIDENCE_SEAL_CHANGE_REVIEW_PENDING: {
    code: 20044,
    message: '仍有待处理的变更审核,不可封场',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §5.8 ⑦「版本在本事务内变化 ⇒ 拒绝」。ActivityEvidenceState 不在 Activity 行锁的
  // 保护范围内,绕过锁序的写入方能在读取与落章之间改动版本 —— 那一章会记录一个
  // 从未同时成立过的现场快照,故必须拒绝而不是覆盖。
  EVIDENCE_SEAL_REVISION_CHANGED: {
    code: 20045,
    message: '证据或人口版本在封场过程中发生变化,请重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §3.17「新证据或人口变化会递增 state revision,使旧 seal 失配」的**逆命题**:
  // 版本没变 ⇒ 现有 active seal 仍然有效 ⇒ 没有可封的新事实。
  // 这条同时是并发败者的收场码(两个并发 seal 只能成功一个,§5.8 ①的行锁串行化之后,
  // 后到者读到的正是先到者刚写下的、版本完全吻合的 active seal)。
  EVIDENCE_SEAL_ALREADY_ACTIVE: {
    code: 20046,
    message: '当前版本已有生效的封场凭证,无需重复封场',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第二刀:结算草稿生成(合同 §5.9)=====
  //
  // 沿第一刀同一立场:**每一条拒绝理由一个具名码**。草稿生成的每一次拒绝都意味着
  // "这场活动此刻还不能算账",负责人必须知道差的是哪一项 —— 笼统一个状态码会让
  // 机器判定退化回人工排查。落 200xx 段 20047-20051(20040-20046 是第一刀封场)。
  // 全部 409:每一条都是"当前状态不允许",不是入参错。

  // §5.9 首句「输入必须是 active EvidenceSeal」的三种不满足形态,**分成三个码**:
  // 它们对负责人意味着三件完全不同的事(去封场 / 重新封场 / 先处理新证据再封场)。
  SETTLEMENT_DRAFT_EVIDENCE_SEAL_MISSING: {
    code: 20047,
    message: '活动尚未封场,不可生成结算草稿',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED: {
    code: 20048,
    message: '封场凭证已失效,请重新封场后再生成结算草稿',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §3.17「新证据或人口变化会递增 state revision,使旧 seal 失配」。
  // seal 行还是 active,但它记录的三个版本号已经不是现在的事实 ——
  // 拿它当输入等于按一份过期的现场快照算账。
  SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE: {
    code: 20049,
    message: '封场凭证与当前证据/人口版本不一致,请重新封场',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §5.9 末句「500 人以内可同步生成 working draft;更大规模创建 ActivityBatchJob」。
  // 本刀**只实现同步路径**,超阈值明确拒绝并提示走批处理(批处理归第五刀)——
  // 不悄悄降级、也不硬撑着同步跑完。
  SETTLEMENT_DRAFT_POPULATION_TOO_LARGE: {
    code: 20050,
    message: '结算人口超过同步生成上限,请改用批处理任务',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §4.7:`drafting` 是唯一"正在编草稿"的结算状态。已提交/审核中/已发布/已关账的 run
  // 再重新生成 working draft,会把审核依据从脚下抽走(§5.10「提交后 working draft
  // 不再是审核依据。修改必须从 returned 状态创建新 version」)。
  SETTLEMENT_DRAFT_RUN_STATUS_INVALID: {
    code: 20051,
    message: '当前结算状态不允许重新生成草稿',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第三刀:提交不可变 SettlementVersion(合同 §5.10)=====
  //
  // 🔴 **提交是单向门**:固化之后只能退回重来,而退回是人工成本。所以这一段的每一条
  //    都是**拒绝**,没有一条是"警告后放行"——宁可多拒,不可少拒。
  //    落 200xx 段 20052-20061(20040-20046 封场 / 20047-20051 草稿生成)。全部 409。
  //
  // ⚠️ 刻意**不复用** 20047-20051:那几条的 message 写的是"生成结算草稿",而这里
  //    负责人面对的是完全不同的一个动作(提交送审)。同因不同果,分码。

  // ① 前置:run / 草稿版本形态(§5.10 ①②)
  //
  // §4.7 的状态链是 `drafting → submitted`:只有 `drafting` 能提交。
  // 已提交/审核中/已发布/已关账再提交一次,等于把审核依据从审核人脚下换掉。
  SETTLEMENT_SUBMIT_RUN_STATUS_INVALID: {
    code: 20052,
    message: '当前结算状态不允许提交送审',
    httpStatus: HttpStatus.CONFLICT,
  },
  // run 在 drafting,但一个 draft 版本都没有 —— 没有可固化的内容。
  SETTLEMENT_SUBMIT_DRAFT_MISSING: {
    code: 20053,
    message: '尚无结算草稿可提交,请先生成草稿',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ② EvidenceSeal 复验(§5.10 ③)。本刀**只复验、不重新封场**。
  //
  // 两条分开:"没有 active seal"要去重新封场;"seal 还在但版本已经不是当前事实"
  // 要先处理新证据 —— 对负责人是两件事。
  SETTLEMENT_SUBMIT_EVIDENCE_SEAL_INACTIVE: {
    code: 20054,
    message: '封场凭证已失效,请重新封场后再提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE: {
    code: 20055,
    message: '封场凭证与当前证据/人口版本不一致,请重新封场并重新生成草稿',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ③ §5.10 ④ 的五条校验,一条一个码。
  //
  // ⭐ 20056 是**第二刀那个设计的执行位**:第二刀把「未决」表达成"不写结果行"
  //    (§3.20 的 resultCode 十值闭集里没有"尚未认定"),该设计成立的唯一前提就是
  //    "人口里有他、结果表里没有他 ⇒ 提交被拒"。这条写松,未决的人会安静地不出现在
  //    版本里,而版本自称已覆盖全部人口。
  SETTLEMENT_SUBMIT_PENDING_RESULT: {
    code: 20056,
    message: '仍有队员的结算结果未认定,请先逐一认定后再提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 基数式:结果行数 ≠ 人口数。与 20056 互为表里(包含式 / 基数式),各抓一侧形态,
  // 详见 settlement-submission-validator.ts 文件头「两条闸守同一件事」。
  SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH: {
    code: 20057,
    message: '结算项数与应结算人口不一致,请重新生成草稿',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 防御位:DB unique 已使其在应用路径上不可达(见 validator 文件头的诚实说明)。
  SETTLEMENT_SUBMIT_DUPLICATE_IDENTITY: {
    code: 20058,
    message: '结算项存在重复的参与身份,请重新生成草稿',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 还有人没签退就提交:没有签退时刻就没有时长,固化的是一笔算不出来的账。
  SETTLEMENT_SUBMIT_OPEN_SEGMENT: {
    code: 20059,
    message: '仍有未闭合的服务段,请先处理签退后再提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 第二刀标的「应计分无有效贡献规则」blocker,必须在这里真正挡住提交 ——
  // 否则那条 blocker 就只是个装饰。
  SETTLEMENT_SUBMIT_MISSING_RULE: {
    code: 20060,
    message: '存在缺少有效贡献规则的结算项,请先补齐规则后再提交',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ④ 幂等(§5.10 ⑥):`operationKey + requestHash` 防重。
  //
  // 同 key 同 payload ⇒ 返回同一个版本(不是错误);**同 key 不同 payload ⇒ 本码**。
  // ⚠️ 第 1 批实测:复合唯一恰好放行"同 key 不同 payload" —— 所以这条判据不能靠
  //    复合唯一,而是在持有 run 行锁的事务内按单列 operationKey 查后显式比对。
  SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT: {
    code: 20061,
    message: '相同操作标识已用于不同的提交内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第四刀:一审 / 终审(合同 §5.11 + §3.19)=====
  //
  // 🔴 **这一段守的是"谁说了算"。** 隔离漏一条,自提自审就成立(合同 §4.1 与修订说明
  //    列为一级阻断的同一类问题);并发漏一条,同一版本会有两个互相矛盾的生效决定。
  //    落 200xx 段 20062-20076。**全部 409**:每一条都是"当前状态/当前人不允许",
  //    不是入参格式错。
  //
  // ⚠️ 刻意**不复用** 20052-20061(提交段):那几条的 message 面向的是"提交送审"的
  //    负责人,而这里面对的是**审核人**。同因不同果,分码。

  // ① 三方分离(§3.19「事务内锁后复判提交人／一审人／终审人分离」)。
  //
  // 🔴 三条**各一个码,不合并**:合并成一个"人员隔离不通过"会让"哪一条没有执法位"
  //    再也读不出来 —— 卸掉任意一条,红集都指向同一个码。判定见
  //    `activities/settlement-review-separation.ts`(三条互不重叠是那里的结构前提)。
  //
  // 命名与 22074/22075(考勤三审隔离)**逐字对齐**,因为它们是同一条域不变量在
  // 两个业务对象上的两次落地;码值分开是因为对外 message 面向不同的动作。
  SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN: {
    code: 20062,
    message: '不可一审自己提交的结算版本',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN: {
    code: 20063,
    message: '不可终审自己提交的结算版本',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_SAME_REVIEWER_FORBIDDEN: {
    code: 20064,
    message: '一审人不可再对同一结算版本终审',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ② 状态闸。run 与 version 各判各的:run 是流程根(§3.19「页面投影和流程根」),
  //    version 是审核对象本身;两者不同步(如版本已被别的路径 void)时必须各自拒。
  SETTLEMENT_REVIEW_RUN_STATUS_INVALID: {
    code: 20065,
    message: '当前结算状态不允许执行该审核动作',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_REVIEW_VERSION_STATUS_INVALID: {
    code: 20066,
    message: '该结算版本当前状态不可审核',
    httpStatus: HttpStatus.CONFLICT,
  },
  // run 指针指向的提交版本行取不到 —— 没有审核对象。
  SETTLEMENT_REVIEW_VERSION_MISSING: {
    code: 20067,
    message: '未找到待审核的结算版本',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ③ §5.11「比较 seal / revisions / workflow / contentHash」的四项,一项一个码。
  //    判定见 `activities/settlement-review-comparison.ts`(四项读互不相交的字段)。
  //
  // ⭐ 20071 是**第三刀 canonical contentHash 的执行位**:本刀**只比对不重算**
  //    (重算等于把"审的是哪一版"又交回给可变数据)。这条写松,审核人就可能在
  //    不知情的情况下批准了一份他没看过的内容。
  SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE: {
    code: 20068,
    message: '封场凭证已变化,该结算版本不可审核,请重新封场并重新提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED: {
    code: 20069,
    message: '证据或人口版本已变化,该结算版本不可审核,请重新生成草稿并提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED: {
    code: 20070,
    message: '活动流程版本已变化,该结算版本不可审核,请重新生成草稿并提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED: {
    code: 20071,
    message: '审核内容摘要与该结算版本不一致,请刷新后重新审核',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ④ §3.19「一版本一阶段只允许一个生效决定」。
  //
  // ⚠️ 这条**不是**靠 DB 唯一约束:`SettlementReviewAction` 上只有 `operationKey`
  //    单列 unique(§3.19 点名的那一条),没有 `(settlementVersionId, stageCode)` 唯一。
  //    正确性来自 **SettlementVersion 行锁**把同一版本上的并发审核串行化,
  //    锁后再查一次已有决定。approve 与 return 并发时,败者收这个码。
  SETTLEMENT_REVIEW_ALREADY_DECIDED: {
    code: 20072,
    message: '该结算版本在此审核阶段已有生效决定',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 同 key 同 payload ⇒ 返回同一条决定(不是错误);**同 key 不同 payload ⇒ 本码**。
  // 与 20061 同一范式:`operationKey` 单列 unique,P2002 也翻成本码,不裸奔成 500。
  SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT: {
    code: 20073,
    message: '相同操作标识已用于不同的审核内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ⑤ 动作面。§5.11「只允许 approve 或 return」——**第三种动作不存在**。
  //    类型联合是编译期闸;本码是运行期兜底(调用方绕过类型时不得裸奔成 500)。
  SETTLEMENT_REVIEW_ACTION_INVALID: {
    code: 20074,
    message: '结算审核只支持通过或退回',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §5.11「return 写原因」。退回没有原因,负责人不知道要改什么 —— 那条退回等于噪音。
  SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED: {
    code: 20075,
    message: '退回结算版本必须填写退回原因',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §5.11「return 只能在 batch 未 committed 前执行」。批次一旦 committed,钱已经记进
  // 账本 —— 那时"退回"不是退回,是需要走更正流程(§5.14)。
  SETTLEMENT_REVIEW_BATCH_ALREADY_COMMITTED: {
    code: 20076,
    message: '账本发布批次已生效,不可再退回,请改走更正流程',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第五刀:账本分块准备 + 短事务统一生效 =====
  // (合同 §5.12 + §5.13 + §3.22 / §3.23 / §3.24)
  //
  // 🔴🔴 **这一段是全仓语义最像钱的一段。** committed 之后的 `ParticipationLedgerEntry`
  //    就是队员贡献值真值,而维护者看不懂代码、发现不了账错。所以这里**没有一条**
  //    走"警告后放行":每一条都是**拒绝**,宁可多拒,不可少拒。
  //    落 200xx 段 20077-20089(20062-20076 是第四刀审核)。
  //
  // ⚠️ 全段 **409**,只有一条例外(20087 是 429):它不是"你做错了",而是
  //    "此刻并发预算不够,过一会儿重发就行" —— 语义上属于限流而不是冲突。

  // ① §5.12 准备阶段(worker)。
  //
  // 批次不在 `preparing` 却被要求准备:要么已经 ready/committed(重复准备会写第二遍分录),
  // 要么已 voided/failed(照着一条已作废的批次入账 = 记一份被退回的账)。
  LEDGER_PREPARE_BATCH_STATUS_INVALID: {
    code: 20077,
    message: '账本发布批次当前状态不允许准备',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 🔴 §3.21「按北京日拆分」的 fail-closed 位:结果修订上有非零认定值,却找不到任何
  //    可归属的服务日(一条服务段都没有 ⇒ 没有 `ledgerDate` 可挂)。
  //    这时**不能**随手挂到活动日或场次日 —— 那是发明一个从未发生过的服务事实,
  //    并且会直接影响该队员当日的贡献值上限分配。只能拒绝并等人处理。
  LEDGER_PREPARE_DAY_SPLIT_UNRESOLVED: {
    code: 20078,
    message: '存在无法归属到服务日的结算认定值,不可准备入账',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 结果修订不是 `draft`:`committed` 说明它已经随别的批次入过账(重复入账),
  // `superseded` 说明它已被更正取代(照着旧版入账)。两种都是账错,不是流程问题。
  LEDGER_PREPARE_RESULT_REVISION_STATUS_INVALID: {
    code: 20079,
    message: '结算结果修订当前状态不允许入账',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ② §5.13 统一生效的前置状态闸。三条分开:三者不同步时(如批次被别的路径作废、
  //    run 被退回)负责人面对的是三件不同的事。
  LEDGER_COMMIT_BATCH_STATUS_INVALID: {
    code: 20080,
    message: '账本发布批次尚未准备就绪,不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  LEDGER_COMMIT_RUN_STATUS_INVALID: {
    code: 20081,
    message: '当前结算状态不允许账本生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  LEDGER_COMMIT_VERSION_STATUS_INVALID: {
    code: 20082,
    message: '该结算版本当前状态不可入账',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §3.22「一个 SettlementVersion 至多一个 committed posting batch」——
  // DB 上有 partial unique 兜底(`ledger_posting_batch_committed_unique`),
  // 本码是锁后的显式判定,让并发败者收到具名结论而不是 P2002 裸奔。
  LEDGER_COMMIT_VERSION_ALREADY_POSTED: {
    code: 20083,
    message: '该结算版本已有生效的账本批次,不可重复入账',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ③ ⭐⭐ §5.13 ⑤⑥ **baseline 比对** —— 本刀最核心的正确性判据。
  //
  // 准备阶段按当时的 day-state 版本算出 credited / cappedOut;若在准备完成之后、
  // 生效之前有别的批次动过同一 member/date,那份 credited 就是按一份过期的世界算的。
  // **整批拒绝,不允许部分生效** —— 部分生效会产出一个看起来正常、实则半新半旧的账本。
  LEDGER_COMMIT_BASELINE_CHANGED: {
    code: 20084,
    message: '队员日账基线在准备之后发生变化,本批次不可生效,请重新准备',
    httpStatus: HttpStatus.CONFLICT,
  },
  // baseline 明细(存于 job payload)与批次上记录的摘要 `baselineJsonHash` 不符。
  // 正常路径不可达 —— 它守的是"有人绕过应用层改了准备结果"这一形态。
  // 与 20084 分码:那条是**世界变了**,这条是**记录被动过**,运维含义完全不同。
  LEDGER_COMMIT_BASELINE_DIGEST_MISMATCH: {
    code: 20085,
    message: '账本批次基线摘要校验不通过,本批次不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ④ ⭐⭐ §3.24 末句「日合计必须 0..3」的**唯一执行位**。
  //
  // 🔴 这是**跨行**不变量(同 member 同 ledgerDate 多条分录求和),第 1 批已实测判定
  //    「表级 CHECK 只看单行、trigger 求和在并发下骗人」⇒ 刻意零 DB 执行位。
  //    因此本码所在的那次判定(member advisory lock 内、day-state `FOR UPDATE` 之后)
  //    是全仓唯一挡住它的地方。写松 = 队员贡献值当日可以无声地超过上限。
  LEDGER_COMMIT_DAILY_CAP_EXCEEDED: {
    code: 20086,
    message: '本批次会使队员当日贡献值合计超出上限,不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ⑤ ⭐⭐ 「万人统一生效恒串行」的执行位(维护者 2026-08-04 拍板;
  //    `docs/current-state.md` §「活动业务改造」逐字记录)。
  //
  // 背景实测(第 0 批锁原型 `docs/archive/reviews/activity-business-overhaul-v1.1-lock-probe.md`):
  //   advisory 锁占 PostgreSQL **共享**锁表,公式保底
  //   `max_locks_per_transaction × (max_connections + max_prepared_transactions)` = 64×200 = **12800**;
  //   一场万人生效实占 10000 把(78%)⇒ 两场并发即越过保底,落进 `out of shared memory`。
  //   那是**硬 ERROR**,不走 `lock_timeout` → 55P03 → 40901 的可重试路径,事务直接中止。
  //
  // 20087:此刻并发预算不够 —— **可重试**,过一会儿重发即可(故 429 而非 409)。
  // 20088:这一场自己就超过预算总量 —— **重试无用**,须运维提高
  //        `max_locks_per_transaction`(生产库配置 + 重启)或重新拍板生效粒度。
  //        两者分码正是因为「该不该重试」相反。
  LEDGER_COMMIT_LOCK_BUDGET_EXHAUSTED: {
    code: 20087,
    message: '已有其它账本批次正在生效,当前并发锁预算不足,请稍后重试',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
  },
  LEDGER_COMMIT_SCALE_EXCEEDS_LOCK_BUDGET: {
    code: 20088,
    message: '本场结算人数超过数据库共享锁预算总量,须先调整数据库配置',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ⑥ §5.12 ⑧「全部 item 成功且数量、摘要一致时 batch 才进 ready」的生效侧复核:
  //    真实分录集合与批次自称的准备结果不一致 ⇒ 不生效。
  LEDGER_COMMIT_ENTRY_SET_MISMATCH: {
    code: 20089,
    message: '账本批次的准备分录与批次记录不一致,不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  // ⚠️ **刻意没有** `LEDGER_COMMIT_OPERATION_KEY_CONFLICT`(对照 20061 / 20073)。
  //    生效动作的 payload **完全由 batchId 决定** —— 不存在"同 key 不同 payload"这种形态,
  //    造一个码出来只会是永远打不到的死码。幂等锚点就是 batchId 本身:
  //    重放时批次已是 `committed` ⇒ 原样返回上一次的结论(`replayed: true`),
  //    而"一个版本至多一个 committed 批次"由 DB partial unique
  //    `ledger_posting_batch_committed_unique` 兜底(20083 是它的锁后具名版本)。

  // ===== 活动改造 v1.1 第 2 批第六刀:机器关账(合同 §5.15 + §3.26)=====
  //
  // 🔴 **关账是"这场活动的账算完了"的唯一权威。** 合同 §1.2 把它从「负责人声明」
  //    改成机器检查:八类判定全过才追加一张 `ActivitySettlementClosureRevision`。
  //    落 200xx 段 20090-20098(20077-20089 是第五刀账本)。
  //
  // ⭐ **前八条不是"错误码",是缺口码**(§5.15 ⑫「返回**结构化缺口码和数量**」)。
  //    它们由 `ActivityClosureService.close()` 以 `{ outcome:'blocked', gaps:[...] }`
  //    **返回**(不是抛出)—— 因为一次关账尝试可能同时缺好几类,而维护者看不懂代码,
  //    只告诉他"关账失败"等于把排查成本原样推给他。返回体逐类带 `count` 与
  //    `details`(逐项计数),页面就能直接渲染成合同 §6 说的那份"缺口清单"。
  //    ⇒ 本仓 `BizException` 只能携带一个 `BizCodeEntry`(且 `biz.exception.ts` 不在
  //      本刀写集内),这是"返回而非抛出"的第二个、也是结构性的理由。
  //
  // ⚠️ 全段 409:每一条都是"当前事实还不允许关账",不是入参格式错。
  //
  // 八类与合同步骤的对应(逐条,报告里另有对照表):
  //   20090 ← §5.15 ③ 的执行态一半(§9.2 ①)
  //   20091 ← §5.15 ③ 的封场一半(§9.2 ②)
  //   20092 ← §5.15 ④   20093 ← §5.15 ⑤   20094 ← §5.15 ⑥
  //   20095 ← §5.15 ⑦   20096 ← §5.15 ⑧   20097 ← §5.15 ⑨
  // §5.15 ③ 拆成两类**不是自作主张**:§9.2 把"已结束/已终止"与"已封场"列为**两道**
  // 硬检查,合并成一个码会让"哪一道没有执法位"再也读不出来(沿 20062-20064 的分码理由)。

  ACTIVITY_CLOSURE_EXECUTION_NOT_ENDED: {
    code: 20090,
    message: '活动尚未自然结束或正式提前终止,不可关账',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_EVIDENCE_NOT_SEALED: {
    code: 20091,
    message: '当前证据版本尚未封场或封场凭证已失配,不可关账',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_PENDING_WORK_EXISTS: {
    code: 20092,
    message: '仍有待处理的变更、更正、人工复核、开放服务段或未完成批量任务',
    httpStatus: HttpStatus.CONFLICT,
  },
  // ⭐ §9.2 的那句话就是这条码:「30 人报名通过、0 打卡、0 人员结果时……必须拒绝关闭,
  //    并清楚提示 30 个队员×场次尚未处理」—— `count` 就是那个 30。
  ACTIVITY_CLOSURE_PARTICIPATION_UNRESOLVED: {
    code: 20093,
    message: '仍有报名、邀请或参与身份未形成终态,或与应结算人口不一致',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE: {
    code: 20094,
    message: '当前结算版本未终审生效或未覆盖全部应结算人口',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_RESULT_INCONSISTENT: {
    code: 20095,
    message: '存在服务段缺失、零时长结果金额不为零或标签不一致的人员结果',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_LEDGER_INCOMPLETE: {
    code: 20096,
    message: '正式账本尚未全部生效,或存在日上限、重复入账、时间重叠、名额对账异常',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §5.15 ⑨。更正后重新关账**不走特例分支**:§5.14 ⑥ 要求更正 commit 事务内先把旧
  // active closure 投影成 superseded,届时本条自然为真(DB partial unique
  // `activity_settlement_closure_active_unique` 也只允许这一条路)。
  // 🔴 并发败者(P2002 撞该 partial unique)也翻成本码,**不让 Prisma 异常裸奔成 500**。
  ACTIVITY_CLOSURE_ALREADY_ACTIVE: {
    code: 20097,
    message: '该活动已有生效的关闭版本,请先完成更正流程再重新关账',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 幂等(§5.15 ②)。同 key 同 payload ⇒ 返回同一张 closure(不是错误);
  // **同 key 不同 payload ⇒ 本码**。与 20061 / 20073 同一范式。
  //
  // ⚠️ 与那两条的**唯一实质差别**:§3.26 的字段表没有给 `ActivitySettlementClosureRevision`
  //    任何 operationKey / requestHash 列(而 §5.15 ② 又要求按它们防重)——
  //    合同内部不一致,已在报告作为新 finding 上报。本刀零 schema,幂等键存进
  //    `checksJson.idempotency`,去重域因此是 **(activityId, operationKey)**,
  //    正确性来自**第一把 Activity 行锁**(所有关账写入都先取它),不是 DB unique。
  ACTIVITY_CLOSURE_OPERATION_KEY_CONFLICT: {
    code: 20098,
    message: '相同操作标识已用于该活动的其它关账内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第七刀:更正应用(合同 §5.14 + §3.25)=====
  //
  // 🔴🔴 **更正是全仓唯一能改动"已生效账本"的通路。** 冲错、冲两次、冲了没补、
  //    补了没冲 —— 每一种都会产出一个看起来完全正常的账本,而维护者看不懂代码、
  //    发现不了。故本段每一条都是**拒绝**,没有一条是"警告后放行"。
  //    落 200xx→201xx 段 20099-20111(20090-20098 是第六刀关账)。
  //
  // ⚠️ **号段说明**:200xx 到 20099 就用满了,本段续到 2010x。头部索引把 XX1xx 标为
  //    「权限边界」,但 activities 段的 20120-20127 早已是**业务码**(报名截止、
  //    已取消禁报名等),⇒ 201xx 在本模块**事实上**已是业务码续段,本段沿这一既成口径,
  //    不另开新段位(新开段位会让 activities 的码散落在两个不相邻的段里)。
  //
  // ⚠️ 全段 409:每一条都是"当前事实不允许这么做",不是入参格式错。
  //    唯一例外是 20102(400):它判的是 `requestedChangeJson` 的**形状**。
  //
  // 逐条与合同步骤的对应:
  //   20099 ← §5.14 ① run 状态      20100 ← §5.14 ① base 版本
  //   20101 ← §3.25 partial unique   20102 ← §3.25 `requestedChangeJson`(合同未给字段表)
  //   20103 ← §5.14 ② 状态闸         20104 ← §7.5 人员隔离
  //   20105 ← §3.25 末句 base 漂移    20106 ← §5.14 ③ 应用状态闸
  //   20107 ← §3.23.5 至多冲一次
  //   20108/20109/20110 ← §5.14 ④ 配对三条(只冲不补 / 只补不冲 / 金额不相反)
  //   20111 ← 幂等撞键(与 20061 / 20073 / 20098 同一范式)

  CORRECTION_SUBMIT_RUN_STATUS_INVALID: {
    code: 20099,
    message: '该活动的结算尚未生效,不可提交更正申请',
    httpStatus: HttpStatus.CONFLICT,
  },
  CORRECTION_SUBMIT_BASE_VERSION_INVALID: {
    code: 20100,
    message: '未找到可作为更正基础的已生效结算版本',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §3.25「partial unique 保证同一 target 同一时刻至多一个 pending/returned/approved/applying」。
  // 🔴 service 锁后检查是第一道,DB `attendance_correction_request_open_unique` 是第二道;
  //    P2002 也翻成本码,**不让 Prisma 异常裸奔成 500**(与 20083 / 20097 同一范式)。
  CORRECTION_TARGET_ALREADY_OPEN: {
    code: 20101,
    message: '该对象已有处理中的更正申请,请先完成或撤销后再提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  // ⚠️ 400 而非 409:它判的是入参形状。§3.25 **没有给** `requestedChangeJson` 的字段表
  //    (合同在这里是空的),闭集由本刀 `correction-change-set.ts` 补齐并在报告列明。
  CORRECTION_CHANGE_SET_INVALID: {
    code: 20102,
    message: '更正内容的格式或取值不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CORRECTION_REVIEW_STATUS_INVALID: {
    code: 20103,
    message: '该更正申请当前状态不允许此审核动作',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §7.5「Correction review:request submitter != reviewer;**若更正由原结算提交人提出仍适用**」。
  // 后半句不是废话:它堵的正是"他最了解账、让他自己批"这条很自然的口子。
  CORRECTION_REVIEW_SELF_FORBIDDEN: {
    code: 20104,
    message: '更正申请的提交人不能审核本人提交的申请',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §3.25 末句「审核时基础版本变化则置 voided 并要求新申请」。
  // ⚠️ 审核路径上这**不是**异常:置 voided 要落库,故 `review` 走**返回值**
  //    (`{ outcome:'voided' }`);抛本码的只有 `prepare`(那时申请已被独立事务置 voided)。
  CORRECTION_BASE_VERSION_CHANGED: {
    code: 20105,
    message: '更正所依据的结算版本已变化,该申请已作废,请重新提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  CORRECTION_APPLY_STATUS_INVALID: {
    code: 20106,
    message: '该更正申请当前状态不可应用',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §3.23.5「一条原 entry 至多被一个 committed reversal 逻辑冲回」。
  // service 锁后检查 + `LedgerEntryReversalClaim.originalEntryId` unique 两道,同翻本码。
  CORRECTION_REVERSAL_ALREADY_CLAIMED: {
    code: 20107,
    message: '存在已被冲回过的原始账本分录,不可重复冲回',
    httpStatus: HttpStatus.CONFLICT,
  },
  // ⭐ §5.14 ④ 的配对三条**分三个码**(不合并):合并成一条会让"哪一种残缺没有执法位"
  //    再也读不出来(沿 20062-20064 / 20090-20097 的分码理由)。
  //    三条各读**自己那几个计数**,卸掉任一条只有它对应的用例会红。
  CORRECTION_POSTING_REPLACEMENT_MISSING: {
    code: 20108,
    message: '更正批次只有冲回、缺少对应的补记分录,不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  CORRECTION_POSTING_REVERSAL_MISSING: {
    code: 20109,
    message: '更正批次未把原有已生效分录全部冲回,不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  CORRECTION_POSTING_REVERSAL_AMOUNT_INVALID: {
    code: 20110,
    message: '冲回分录的金额不是原分录的相反数,不可生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  CORRECTION_OPERATION_KEY_CONFLICT: {
    code: 20111,
    message: '相同操作标识已用于该活动的其它更正内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第 ⑧a 刀:worker 自动提交 =====
  //
  // §5.11 的终审 approve 是账本责任人的唯一真源。批次创建者字段只是准备动作的
  // 过程留痕,系统账号则根本没有拍板责任;两者都不得拿来替代终审人。
  LEDGER_COMMIT_FINAL_APPROVER_MISSING: {
    code: 20112,
    message: '未找到该结算版本的终审通过记录,账本批次不可自动生效',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_DRAFT_OPERATION_KEY_CONFLICT: {
    code: 20113,
    message: '相同操作标识已用于其它结算草稿生成内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 2 批第 ⑧b 刀:HTTP 版本锚点(合同 §6.14) =====
  //
  // HTTP 请求携带的是操作者刚刚确认过的版本锚点。比较必须落在既有事务、既有锁之后:
  // 锁外预查在并发下只能说明“刚才看见过”,不能说明“此刻将要提交/审核/关账的就是它”。
  // 五条各自指向一个客户端可刷新的对象,故不合并成笼统的“版本已变化”。
  SETTLEMENT_SUBMIT_EXPECTED_DRAFT_VERSION_MISMATCH: {
    code: 20114,
    message: '结算草稿版本已变化,请刷新后重新确认提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_SUBMIT_EXPECTED_EVIDENCE_SEAL_MISMATCH: {
    code: 20115,
    message: '结算草稿引用的封场凭证已变化,请刷新后重新确认提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH: {
    code: 20116,
    message: '待审核的结算版本已变化,请刷新后重新审核',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_EXPECTED_SETTLEMENT_VERSION_MISMATCH: {
    code: 20117,
    message: '待关账的结算版本已变化,请刷新后重新确认关账',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CLOSURE_EXPECTED_POSTING_BATCH_MISMATCH: {
    code: 20118,
    message: '待关账的账本批次已变化,请刷新后重新确认关账',
    httpStatus: HttpStatus.CONFLICT,
  },
  // ===== 活动改造 v1.1 第 2 批第 ⑨a 刀：负责人 working draft 编辑 =====
  //
  // PATCH 的锚点仍然是 run.currentDraftVersion，但它和 submit 是两个不同动作：客户端
  // 要据此分别决定「刷新后继续编辑」还是「刷新后重新确认提交」，不得复用 20114。
  SETTLEMENT_DRAFT_UPDATE_EXPECTED_DRAFT_VERSION_MISMATCH: {
    code: 20119,
    message: '结算草稿版本已变化,请刷新后重新编辑',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 20120–20127 已是既有活动报名状态码；本刀从其后首个空位续号，不能重用旧语义。
  // `drafting` 是工作区唯一可编辑态；`closed` 是 `posted` 的下游态，统一走这条闸，
  // 不能只列 submitted / posted 而遗漏关账后继续改草稿的旁路。
  SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID: {
    code: 20128,
    message: '当前结算状态不允许编辑草稿',
    httpStatus: HttpStatus.CONFLICT,
  },
  // resubmit 的 path anchor 必须是已经被审核退回的 immutable version，不能把任一版本
  // 当作「重提」理由而静默提交当前草稿。
  SETTLEMENT_RESUBMIT_VERSION_NOT_RETURNED: {
    code: 20129,
    message: '该结算版本尚未退回,不可重新提交',
    httpStatus: HttpStatus.CONFLICT,
  },

  // ===== 活动改造 v1.1 第 3 批第一刀:草稿 / 场次 / 场次岗位 =====
  // 草稿创建的 v1.1 配置字段、以及后续场次约束均由服务层先行校验；数据库 CHECK/unique
  // 只是并发与绕过应用层时的最后防线，不能把 Prisma 错误裸露给调用方。
  ACTIVITY_DRAFT_CONFIGURATION_INVALID: {
    code: 20130,
    message: '活动草稿配置无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_CODE_ALREADY_EXISTS: {
    code: 20131,
    message: '同一活动已存在相同场次编码',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_SESSION_NAME_ALREADY_EXISTS: {
    code: 20132,
    message: '同一活动已存在同名场次',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_SESSION_CAPACITY_INVALID: {
    code: 20133,
    message: '场次名额配置无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_TIME_RANGE_INVALID: {
    code: 20134,
    message: '场次时间范围无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_WINDOW_INVALID: {
    code: 20135,
    message: '场次签到或签退窗口无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_LOCATION_POLICY_INVALID: {
    code: 20136,
    message: '场次定位策略无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS: {
    code: 20137,
    message: '同一场次已存在相同岗位编码',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS: {
    code: 20138,
    message: '同一场次已存在同名岗位',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_SESSION_POSITION_CAPACITY_INVALID: {
    code: 20139,
    message: '场次岗位名额配置无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID: {
    code: 20140,
    message: '场次岗位时间范围无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID: {
    code: 20141,
    message: '场次岗位定位策略无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 第 3 批第三刀取消/提前终止各自有一组单列 operationKey + requestHash。
  // 同 key 同 canonical payload 必须重放原结果；同 key 但内容不同才走本冲突码。
  ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT: {
    code: 20142,
    message: '相同操作标识已用于不同的活动生命周期内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 第 3 批第二刀发布提案链：提交与审核动作各自使用 operationKey + canonical requestHash。
  // 同 key 的语义内容不一致不能静默覆盖已存在审核记录；审批前 Activity 现场发生变化
  // 也不能“以新现场代替旧提案”继续通过，客户端必须刷新并重新发起提案。
  ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT: {
    code: 20143,
    message: '相同操作标识已用于不同的发布审核内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH: {
    code: 20144,
    message: '发布审核预期的活动快照已变化,请刷新后重新提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PUBLISH_REVIEW_LIVE_SESSION_REQUIRED: {
    code: 20145,
    message: '发布活动至少需要一个有效场次',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_PUBLISH_REVIEW_SELF_REVIEW_FORBIDDEN: {
    code: 20146,
    message: '发布审核申请人不得审核本人提交的申请',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  ACTIVITY_CAPACITY_RECONCILIATION_FAILED: {
    code: 20147,
    message: '活动容量与当前占用不一致',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_INVITATION_NOT_FOUND: {
    code: 20148,
    message: '活动邀请不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_INVITATION_STATUS_INVALID: {
    code: 20149,
    message: '活动邀请当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_INVITATION_ALREADY_PENDING: {
    code: 20150,
    message: '该活动范围内已有未过期的待处理邀请',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_INVITATION_OPERATION_KEY_CONFLICT: {
    code: 20151,
    message: '相同操作标识已用于不同的邀请拒绝内容,请更换操作标识',
    httpStatus: HttpStatus.CONFLICT,
  },

  // activity_registrations 模块业务级(210xx + 211xx)。批次 3A 引入(2026-05-11)。
  // 详见 docs:批次3_API前评审决议表.md v1.0 §1.1 / §1.3 + §6.2。
  // 子段(对齐 baseline §1.3):
  // - 21001:NOT_FOUND(含 USER 越权访问他人 → 404;
  //   以 ACTIVITY_REGISTRATION_NOT_FOUND 隐藏资源存在性)
  // - 21002-21009:唯一约束冲突(partial unique:同活动同 member active 报名唯一)
  // - 21030-21099:状态机转移非法
  // - 211xx:暂留(USER NOT_OWNED / FORBIDDEN_REGISTRATION_REVIEW 不开,沿 baseline)
  ACTIVITY_REGISTRATION_NOT_FOUND: {
    code: 21001,
    message: '报名记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_REGISTRATION_ALREADY_EXISTS: {
    code: 21002,
    message: '同一活动同一队员已有有效报名',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT: {
    code: 21003,
    message: '报名操作键与首次请求不一致',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_REGISTRATION_STATUS_INVALID: {
    code: 21030,
    message: '报名记录当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_CAPACITY_EXCEEDED: {
    code: 21032,
    message: '活动名额已满',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 参与域生命周期收口⑦(v0.40.0):已考勤报名禁取消。报名已有未软删考勤记录
  // (AttendanceRecord.registrationId 反向引用)→ cancelAdmin / cancelMy 两路均拒。
  // 不做贡献值回滚(贡献值属考勤域;要撤销参与先走考勤面处理记录,报名取消自然解锁)。
  ACTIVITY_REGISTRATION_HAS_ATTENDANCE: {
    code: 21033,
    message: '报名已有考勤记录,不可取消',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_REGISTRATION_GENDER_MISMATCH: {
    code: 21034,
    message: '报名者性别不符合活动要求',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_POSITION_REQUIRED: {
    code: 21035,
    message: '该活动报名必须选择活动岗位',
    httpStatus: HttpStatus.CONFLICT,
  },
  REGISTRATION_FORM_VERSION_INVALID: {
    code: 21036,
    message: '报名表版本不匹配或已失效',
    httpStatus: HttpStatus.CONFLICT,
  },
  REGISTRATION_FORM_ANSWER_INVALID: {
    code: 21037,
    message: '报名表答案不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED: {
    code: 21038,
    message: '该活动必须使用报名主链提交',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 第 4 批⑧现场临时参加:Form / 资格规则的 operator 与 valueJson runtime 尚未定义。
  // 现场补录绝不猜测或跳过这些条件；一旦命中适用条件，整笔在写入前 fail-closed。
  ACTIVITY_ONSITE_REQUIREMENTS_UNAVAILABLE: {
    code: 21039,
    message: '活动现场临时参加条件暂无法安全判定',
    httpStatus: HttpStatus.CONFLICT,
  },

  // attendances 模块业务级(220xx + 221xx)。批次 3B 引入(2026-05-11)。
  // 详见 docs:批次3_API前评审决议表.md v1.0 §1.8 / §1.14 + 批次3_schema草案 §18.2。
  // 子段(对齐 baseline §1.3):
  // - 22001-22009:Sheet / ActivityCheckIn NOT_FOUND
  // - 22030-22049:Sheet 状态机 / 资源状态(STATUS_INVALID / APPROVED_NOT_EDITABLE / REJECTED_NOT_EDITABLE)
  // - 22050-22099:Record / ActivityCheckIn 实体级(字典 / 时间 / contribution / registration / GPS)
  // - 221xx:暂留(FORBIDDEN_ATTENDANCE_* 不开,沿 baseline;
  //   USER 越权 → 404 隐藏资源存在性)
  //
  // 不开的码:
  // - 22042 ATTENDANCE_SHEET_VERSION_CONFLICT(D37 暂不启用乐观锁)
  // - 22050 ATTENDANCE_RECORD_NOT_FOUND(Q-A9 不暴露独立 record 查询;若 service 内部需要,
  //   走 ATTENDANCE_SHEET_NOT_FOUND 兜底)
  // - 22101-22104 FORBIDDEN_*(沿 baseline;Guard 拒绝走通用 FORBIDDEN / 40300)
  ATTENDANCE_SHEET_NOT_FOUND: {
    code: 22001,
    message: '考勤单据不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ACTIVITY_CHECK_IN_NOT_FOUND: {
    code: 22002,
    message: '活动打卡记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ATTENDANCE_SHEET_STATUS_INVALID: {
    code: 22030,
    message: '考勤单据当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE: {
    code: 22040,
    message: '已审核通过的考勤单据不可修改',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE: {
    code: 22041,
    message: '已驳回的考勤单据不可直接编辑',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_ROLE_CODE_INVALID: {
    code: 22051,
    message: '考勤角色字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_STATUS_CODE_INVALID: {
    code: 22052,
    message: '考勤明细状态字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_TIME_OVERLAP: {
    code: 22060,
    message: '出勤时间段与已有记录重叠',
    httpStatus: HttpStatus.CONFLICT,
  },
  CHECK_OUT_BEFORE_CHECK_IN: {
    code: 22061,
    message: '签退时间须晚于签到时间',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_SERVICE_HOURS_INVALID: {
    code: 22070,
    message: '服务时长须大于 0',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN: {
    code: 22071,
    message: '服务时长不可超过签到签退跨度',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED: {
    code: 22072,
    message: '审核前须为所有出勤记录填写贡献值',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH: {
    code: 22073,
    message: '关联报名记录与考勤活动不一致',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_REGISTRATION_INVALID: {
    code: 22076,
    message: '关联报名必须属于该活动与该队员且已审核通过',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW: {
    code: 22077,
    message: '考勤时间超出活动时间窗',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN: {
    code: 22078,
    message: '请先完成签到再签退',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_CHECK_OUT_IN_FUTURE: {
    code: 22079,
    message: '考勤签退时间不得晚于当前时间',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // GPS 自助打卡 fail-closed：活动坐标缺失/非法、请求坐标绕过 DTO 后非法、原始
  // Haversine 距离超半径统一收口，避免向 App 枚举具体是哪一侧配置异常。
  ACTIVITY_CHECK_IN_LOCATION_VERIFICATION_FAILED: {
    code: 22080,
    message: '当前位置未通过活动打卡范围校验',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // V2 第一阶段批次 4-A 引入(2026-05-12)。详见 docs:批次4_贡献值业务规则_schema草案评审决议表 v1.0
  // D-S11 + 批次4_贡献值业务规则_API草案 v1.0 D-A13。
  //
  // 子段沿 v0.4.0 22xxx attendances 段位扩展(D-S11 锁定):
  // - 22043:FINAL_REJECTED_NOT_EDITABLE(终审驳回 Sheet 不可 edit;与 22040 / 22041 对称)
  // - 22045:FINAL_REVIEW_STATUS_INVALID(终审操作时 Sheet 状态不是 pending_final_review)
  // - 22046:FINAL_REVIEW_NOTE_REQUIRED(终审驳回必须填 finalReviewNote;与 reject reviewNote 对称)
  //
  // 不开的码(沿 D-S11 / batch 3A 范式):
  // - 22042:VERSION_CONFLICT(handoff §7.1 永久不做,D37 暂不启用乐观锁)
  // - 22044:FINAL_REVIEW_FORBIDDEN(D-S2 + batch 3A 不开 FORBIDDEN_* 模块码;
  //   终审权限不足走通用 FORBIDDEN / 40300 / Guard 机制)
  // - 22047:APD_REVIEW_STATUS_INVALID(与 22030 STATUS_INVALID 重叠,统一复用 22030)
  // - 22048:CONTRIBUTION_RULE_NOT_FOUND(无匹配规则时 service 兜底默认值,不抛错)
  // - 22050:ATTENDANCE_RECORD_NOT_FOUND(handoff §7.1 永久不做,Q-A9 不暴露独立 Record 查询)
  ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE: {
    code: 22043,
    message: '终审驳回的考勤单据不可修改',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID: {
    code: 22045,
    message: '考勤单据当前状态不允许终审操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED: {
    code: 22046,
    message: '终审驳回须填写终审备注',
    httpStatus: HttpStatus.CONFLICT,
  },

  // 终态 scoped-authz PR9 引入(2026-07-02;冻结稿 §5.3 ActionConstraint 域不变量,首个 authz 消费者)。
  //
  // 两码 = AuthzService 约束否决(self_approval_forbidden / same_reviewer_forbidden)的对外映射,
  // 语义是「数据完整性不变量,对 SUPER_ADMIN 也生效」,**不是**权限不足 —— 权限不足维持 30100
  // RBAC_FORBIDDEN(22044 FINAL_REVIEW_FORBIDDEN 继续不开,沿 D-S2 决议)。
  // 段位:沿 22xxx attendances 顺延取 22074/22075(22050-22099 原规划 Record 实体级,
  // 22074 起两枚终审判权约束例外借用,就近登记于终审 2204x 块之后)。
  // 活动责任闭环起 same_reviewer 与自审均为严格不变量；兼容 env 不再影响运行时。
  ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN: {
    code: 22074,
    message: '不能终审自己提交的考勤单据',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  ATTENDANCE_SAME_REVIEWER_FORBIDDEN: {
    code: 22075,
    message: '一级审核人不得再终审同一张考勤单据',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN: {
    code: 22081,
    message: '不能一审自己提交或重提的考勤单',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  ATTENDANCE_RETURN_NOTE_REQUIRED: {
    code: 22082,
    message: '退回修改必须填写原因',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTENDANCE_SHEET_RESUBMIT_STATUS_INVALID: {
    code: 22083,
    message: '只有退回修改的考勤单可以重新提交',
    httpStatus: HttpStatus.CONFLICT,
  },

  // contribution_rules 模块业务级(230xx + 231xx)。批次 5-A 引入(2026-05-12)。
  // 详见 docs:批次5-A_贡献值规则CRUD_API前评审.md v1.1 §5(BizCode 锁定 紧凑版)+ §2.2 E3。
  // 段位选择:baseline §1.1 v0.4 "未规划模块从 230xx 起" → v0.5 收口段位归属为 contribution_rules。
  // 与 attendances 段(220xx)解耦:contribution_rules 是配置表 / 独立 module,不与 attendance 业务码混淆。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 23001:NOT_FOUND
  // - 23002:唯一约束冲突(`(activityTypeCode, attendanceRoleCode)` ACTIVE pair 维度)
  // - 23010-23012:业务级输入校验(分值组合 / 活动类型字典 / 考勤角色字典)
  //
  // 不开的码(D6 v1.1 §5 明确):
  // - 23004~23009:无单字段唯一约束
  // - 23030 CONTRIBUTION_RULE_KEY_FIELDS_NOT_EDITABLE:决议 E8,PATCH 禁改字段交给
  //   UpdateContributionRuleDto 白名单 + 全局 ValidationPipe forbidNonWhitelisted 拦截
  // - 23101~23104 FORBIDDEN_*:沿 baseline,权限不足走通用 FORBIDDEN(40300)
  // - 23103 LAST_RULE_PROTECTED:沿 batch 4-B 22048 不抛错路径,删完该维度 attendance 预填走 null
  CONTRIBUTION_RULE_NOT_FOUND: {
    code: 23001,
    message: '贡献值规则不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  CONTRIBUTION_RULE_ACTIVE_DUPLICATE: {
    code: 23002,
    message: '该维度已存在生效中的规则',
    httpStatus: HttpStatus.CONFLICT,
  },
  CONTRIBUTION_RULE_POINTS_INVALID: {
    code: 23010,
    message: '分值字段组合非法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID: {
    code: 23011,
    message: '活动类型字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CONTRIBUTION_RULE_ROLE_CODE_INVALID: {
    code: 23012,
    message: '考勤角色字典 code 不存在或已停用',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // sms 模块业务级(240xx + 241xx)。SMS 基础设施 T3 引入(2026-06-10)。
  // 详见冻结评审稿 docs/archive/reviews/sms-verification-infra-review.md §3.3;
  // 段位选择:baseline §1.1 原 "240xx-290xx 未规划模块预留" 首段,本期实装收口
  // (段位表加行随本 PR,红区例外经 goal 唯一授权)。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 24002:唯一约束冲突(User.phone @unique 含软删占用;send-code 预检 / 绑定复查 / P2002)
  // - 24010:业务级输入校验(验证码统一无效码,**防枚举**:不存在 / 过期 / 已消费 /
  //          已作废〔superseded 或错 5 次〕 / 码值不符 / 归属不符全部统一本码,沿 10007 先例)
  // - 24030 / 24031:通道状态非法 / 上游发送失败(5xx 语义:非客户端之过)
  // - 24120 / 24121:操作频控(同号 60s 间隔 / 同号自然日上限;message 不暴露阈值数字)
  //
  // 不开的码(评审稿 §3.3 明确):
  // - SMS_CODE_EXPIRED / SMS_CODE_ATTEMPTS_EXCEEDED 等细分(防枚举,沿 10007 不拆原则)
  // - 241xx FORBIDDEN_*:权限拒绝走通用 30100 / 40100 / 40300(RBAC_MAP §6 规则 5)
  // - IP throttler 命中沿 TOO_MANY_REQUESTS=42900,不另开
  PHONE_ALREADY_BOUND: {
    code: 24002,
    message: '该手机号已被绑定',
    httpStatus: HttpStatus.CONFLICT,
  },
  SMS_CODE_INVALID: {
    code: 24010,
    message: '验证码错误或已失效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  SMS_CHANNEL_NOT_CONFIGURED: {
    code: 24030,
    message: '短信服务未配置或未启用',
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
  },
  SMS_SEND_FAILED: {
    code: 24031,
    message: '短信发送失败,请稍后重试',
    httpStatus: HttpStatus.BAD_GATEWAY,
  },
  SMS_SEND_INTERVAL_LIMIT: {
    code: 24120,
    message: '发送过于频繁,请稍后再试',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
  },
  SMS_PHONE_DAILY_LIMIT: {
    code: 24121,
    message: '该手机号今日发送次数已达上限',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
  },

  // wechat 模块业务级(250xx + 251xx)。微信小程序登录 T3 引入(2026-06-12)。
  // 详见冻结评审稿 docs/archive/reviews/wechat-mini-login-review.md §3.3 / E-11 / E-21;
  // 段位选择:baseline §1.1 原 "250xx-290xx 未规划模块预留" 首段,本期实装收口
  // (段位表加行随本 PR,红区例外经 goal 唯一授权;沿 24xxx SMS 收口先例)。
  //
  // 子段(对齐 baseline §1.3 紧凑使用,镜像 sms 段布局):
  // - 25002:唯一约束冲突(User.openid @unique 含软删占用;绑定/换绑占用检查 / P2002 兜底)
  // - 25010:业务级输入校验(code2session 微信明确判 code 无效 40029/40163;
  //          login-wechat 命中账号非 ACTIVE/软删同走本码,防侧写统一,评审稿 §4.2)
  // - 25030 / 25031:通道状态非法 / 上游调用失败(5xx 语义:非客户端之过;镜像 24030/24031)
  //
  // 不开的码(评审稿 §3.3 明确,沿 22042/22044 登记范式):
  // - 25001 WECHAT_NOT_BOUND:零 throw 路径(login 未绑走 bindingRequired:true / admin 清除幂等 /
  //   GET me/wechat 返状态对象);未来出现真实触发路径再实装
  // - 251xx FORBIDDEN_*:权限拒绝走通用 30100 / 40100 / 40300(RBAC_MAP §6 规则 5)
  // - 绑定/登录中"手机号无效"不开新码:统一 SMS_CODE_INVALID=24010(沿 login-sms 防枚举体系)
  WECHAT_ALREADY_BOUND: {
    code: 25002,
    message: '该微信已绑定其他账号',
    httpStatus: HttpStatus.CONFLICT,
  },
  WECHAT_CODE_INVALID: {
    code: 25010,
    message: '微信登录凭证无效或已过期',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  WECHAT_CHANNEL_NOT_CONFIGURED: {
    code: 25030,
    message: '微信登录服务未配置或未启用',
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
  },
  WECHAT_API_FAILED: {
    code: 25031,
    message: '微信服务调用失败,请稍后重试',
    httpStatus: HttpStatus.BAD_GATEWAY,
  },

  // insurances 模块业务级(260xx + 261xx)。保险模块 T2 引入(2026-06-13)。
  // 详见冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.3 / E-8;
  // 段位选择:baseline §1.1 原 "260xx-290xx 未规划模块预留" 首段,本期实装收口
  // (段位表加行随 T3 PR,红区例外经 goal 唯一授权;沿 24xxx/25xxx 收口先例)。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 26001-26003:NOT_FOUND 家族(自购保险 / 队保单 / 覆盖行;App 侧他人/不存在/已删
  //   统一 26001 防侧信道,沿 P2-5 findMy 范式,评审稿 E-14)
  // - 26004:唯一约束冲突(覆盖名单 partial unique 单加重复;P2002 兜底同码,镜像 21002)
  // - 26010:业务级输入校验(coverageStart > coverageEnd 跨字段;自购与队保单共用)
  // - 26011-26012:自购保险 CAS / 审核状态冲突(D-INSURANCE v3 PR2)
  // - 26030:活动报名门槛(INSURANCE_REQUIRED)
  // - 26031:Team Join final join 门槛(TEAM_JOIN_INSURANCE_REQUIRED)
  //
  // 不开的码(评审稿 §3.3 明确):
  // - 261xx FORBIDDEN_*:权限拒绝走通用 30100 / 40100 / 40300(RBAC_MAP §6 规则 5)
  // - 过期 vs 无保险不细分:同 26030(前端提示价值无差,评审稿 E-8)
  MEMBER_INSURANCE_NOT_FOUND: {
    code: 26001,
    message: '保险记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  TEAM_INSURANCE_POLICY_NOT_FOUND: {
    code: 26002,
    message: '队保单不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  TEAM_INSURANCE_COVERAGE_NOT_FOUND: {
    code: 26003,
    message: '该队员不在本保单覆盖名单内',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  TEAM_INSURANCE_COVERAGE_ALREADY_EXISTS: {
    code: 26004,
    message: '该队员已在本保单覆盖名单内',
    httpStatus: HttpStatus.CONFLICT,
  },
  INSURANCE_COVERAGE_DATE_RANGE_INVALID: {
    code: 26010,
    message: '起保日期不得晚于到期日期',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  MEMBER_INSURANCE_VERSION_CONFLICT: {
    code: 26011,
    message: '保险记录已更新,请刷新后重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  MEMBER_INSURANCE_REVIEW_STATE_INVALID: {
    code: 26012,
    message: '当前保险审核状态不允许重复审核',
    httpStatus: HttpStatus.CONFLICT,
  },
  // T3 报名门槛(评审稿 §3.3 落点表;过期与无保险不细分,前端提示价值无差,E-8;
  // 409 沿 20120/21030 报名业务态冲突家族;requiresInsurance=false 活动零查询不触发)。
  INSURANCE_REQUIRED: {
    code: 26030,
    message: '该活动要求保险,当前队员无覆盖活动日期的有效保险,不可报名',
    httpStatus: HttpStatus.CONFLICT,
  },
  TEAM_JOIN_INSURANCE_REQUIRED: {
    code: 26031,
    message: '本轮入队要求保险,当前队员无覆盖入队日期的有效保险,无法入队',
    httpStatus: HttpStatus.CONFLICT,
  },

  // realname 实名核验通道(270xx)。招新一期 T2 引入(2026-06-18)。
  // 详见冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md §3.3 / E-R-18;
  // 段位选择:baseline §1.1 原 "270xx-290xx 未规划预留" 首段,本期实装收口
  // (段位表加行随本 T2 PR,红区例外经 goal 唯一授权;沿 24xxx/25xxx/26xxx 收口先例)。
  //
  // 子段(对齐 baseline §1.3;仅通道状态段,镜像 sms 24030/24031 / wechat 25030/25031):
  // - 27030:通道未配置(settings 缺失 / 未启用 / 凭证非 CONFIGURED / production-like DEV_STUB)
  // - 27031:上游调用失败(腾讯云 Error 回执 / HTTP 非 200 / 超时 / 网络 / 缺 Result)
  //
  // 不开的码(评审稿 §3.3 明确):
  // - 271xx FORBIDDEN_*:权限拒绝走通用 30100 / 40300(RBAC_MAP §6 规则 5)
  // - 「核验不匹配」**不是 BizCode**:是 verify 结果,驱动报名状态机 rejected(T3)
  REALNAME_CHANNEL_NOT_CONFIGURED: {
    code: 27030,
    message: '实名核验服务未配置或未启用',
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
  },
  REALNAME_API_FAILED: {
    code: 27031,
    message: '实名核验服务调用失败,请稍后重试',
    httpStatus: HttpStatus.BAD_GATEWAY,
  },

  // recruitment 招新报名业务级(280xx + 281xx)。招新一期 T3 引入(2026-06-18)。
  // 详见冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md §3.3 / E-R-18;
  // 段位选择:baseline §1.1 原 "280xx-290xx 未规划预留"(T2 已收窄至 270xx realname)首段。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 28001/28002:NOT_FOUND(轮次 / 报名)
  // - 28003:唯一约束冲突(同轮同身份证防重复;partial unique P2002 兜底同码)
  // - 28010/28011:业务级输入校验(年龄越界 / 证件照缺;身份证号格式·校验位走通用 422/40000,
  //   紧急联系人<2 走 DTO @ArrayMinSize 通用 422,评审稿 E-R-12/13)
  // - 28030/28031/28032:轮次状态冲突(无 open 轮·已关 / 容量已满 / 开轮唯一性冲突〔十项收口刀B〕)
  // - 28040:人工 resolve 前置态冲突(非可解态 / pending_verification 核验在途 verifyOutcome 空 / mismatch 卡死行 approve)
  //
  // 不开的码(评审稿 §3.3):281xx FORBIDDEN_*(权限拒绝走通用 30100/40300);
  //   「实名核验不匹配」不是 BizCode(是 verify 结果,驱动状态机 rejected)。
  RECRUITMENT_CYCLE_NOT_FOUND: {
    code: 28001,
    message: '招新轮次不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  RECRUITMENT_APPLICATION_NOT_FOUND: {
    code: 28002,
    message: '招新报名记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  RECRUITMENT_DUPLICATE_APPLICATION: {
    code: 28003,
    message: '本轮招新你已提交报名,请勿重复报名',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新可用性收口 F1(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.5):
  // - 28004/28005:同轮活跃报名(非 rejected/withdrawn)openid / phone 去重,付费 OCR **之前**命中即拒
  //   (换证件号也无法用同一微信/手机重复触发付费 OCR;温和文案引导查进度)。共用手机的罕见正常
  //   场景(如家人同机报名)由 admin 单人手动建档路径兜底 —— 评审稿已记为已知取舍。
  RECRUITMENT_DUPLICATE_OPENID_ACTIVE: {
    code: 28004,
    message: '该微信本轮已有报名进行中,请直接查询报名进度;如非本人操作请联系管理员',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_DUPLICATE_PHONE_ACTIVE: {
    code: 28005,
    message: '该手机号本轮已有报名进行中,请查询报名进度;如需共用手机报名请联系管理员协助',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_AGE_OUT_OF_RANGE: {
    code: 28010,
    message: '报名年龄须在 18 至 60 周岁之间',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  RECRUITMENT_ID_CARD_IMAGE_REQUIRED: {
    code: 28011,
    message: '请上传证件照',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  RECRUITMENT_CYCLE_NOT_OPEN: {
    code: 28030,
    message: '当前没有开放报名的招新轮次',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_CYCLE_CAPACITY_FULL: {
    code: 28031,
    message: '本轮招新名额已满',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 十项收口刀B(2026-07-11):开轮唯一性冲突专码(原 count 预检抛通用 40000)。
  // 命中面:count 预检发现其它 open 轮,或并发穿透被 recruitment_cycles_single_open_unique 兜底(P2002 转码)。
  RECRUITMENT_CYCLE_OPEN_CONFLICT: {
    code: 28032,
    message: '已存在开放中的招新轮次,请先关闭后再开启',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL: {
    code: 28040,
    message: '该报名不处于人工待核状态,无法人工核验',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新二期(后段)T2/T3(2026-06-19;评审稿 recruitment-phase2-review.md §3.3 / E-R2-10):
  // - 28041:状态机闸——标门槛/综合评定/发号目标态不符(T2)
  // - 28042:一键发号时编号/账号唯一冲突(撞既有 memberNo / openid / username;整批事务回滚不跳号,
  //   admin 排查后重试)。**不可发号项不走此码**——它们在事务前分区 skip + report、不 block(E-R2-6)。
  // - 28043:当年永久编号流水撞 999 上限(T3 promote;M-4 报错不扩位)
  RECRUITMENT_APPLICATION_WRONG_STATE: {
    code: 28041,
    message: '该报名当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_APPLICATION_NOT_PROMOTABLE: {
    code: 28042,
    message: '发号时编号或账号唯一冲突,本批未发号,请排查后重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_MEMBER_NO_EXHAUSTED: {
    code: 28043,
    message: '本年度永久编号流水已达上限(999)',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新闭环优化 S5(promote 志愿者化;2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §5.2a):
  // promote 现写 gradeCode='volunteer' + 建 VOL 归口部门(Organization.code='VOL',≠ VOD 志愿者组织部);
  // 该归口部门缺失或非 ACTIVE → 在建任何 member 之前清晰失败(不留半成品),供运维校正 seed/组织状态。
  RECRUITMENT_VOLUNTEER_ORG_UNAVAILABLE: {
    code: 28044,
    message: '志愿者归口部门(VOL)缺失或未启用,无法发号转志愿者',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新可用性收口 F2(2026-07-11;评审稿 recruitment-usability-closeout-review.md §3 R1):
  // - 28045:admin 改资料的身份字段条件闸——身份字段(realName/idCardNumber/birthDate/genderCode)
  //   仅 manual_review 态或非大陆证件记录可改;已 verified 的大陆记录(OCR 已核验)不开。
  RECRUITMENT_IDENTITY_FIELDS_LOCKED: {
    code: 28045,
    message: '该报名已通过证件核验,身份字段不可修改(仅人工待核或非大陆证件记录可改)',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新可用性收口 F3(2026-07-11;评审稿 §3 R3 / §6.1 E-U-4):单人手动建档 promote-single。
  // - 28046:登录锚点不可用——openid 与 phone 双缺或双被既有账号占用(R3「不建无登录锚点的号」;
  //   引导先走自助换绑 rebind-wechat / rebind-phone 释放或换新锚,再手动发号)。
  // - 28047:建档资料不全——缺 realName / birthDate / genderCode(非大陆证件未补录;提示先走 F2 admin
  //   改资料 PATCH 补录派生字段,再单人建档)。
  RECRUITMENT_LOGIN_ANCHOR_UNAVAILABLE: {
    code: 28046,
    message:
      '该报名无可用登录锚点(微信与手机均缺失或已被既有账号占用),请先引导申请人自助换绑后再建档',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_PROFILE_INCOMPLETE_FOR_PROMOTE: {
    code: 28047,
    message: '建档资料不全(缺姓名/出生日期/性别),请先在报名资料编辑中补录后再建档',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新四期 S4a(H5 + 手机身份链;2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §3.3/§3.4):
  // - 28050:报名前身份会话凭证(phoneVerificationToken)无效 / 过期 / 已消费(H5 提交端;前端据此引导重新验码)
  // - 28051:换微信换绑时新 openid 已被本轮另一活跃报名占用(防绑到他人报名 → 查询串号)
  // 「手机验证码错/过期」沿 SMS 域 24010(SMS_CODE_INVALID,防枚举);权限拒绝走通用(自助公开无 RBAC 码)。
  RECRUITMENT_IDENTITY_SESSION_INVALID: {
    code: 28050,
    message: '手机验证已失效,请重新获取验证码',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_WECHAT_ALREADY_BOUND: {
    code: 28051,
    message: '该微信已绑定本轮其它报名,无法换绑',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新可用性收口 F6(2026-07-11;评审稿 §3 R4):自助撤销——非终态(promoted/rejected/withdrawn
  // 之外)皆可撤;终态命中 → 本码(温和文案,含幂等重撤)。
  RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE: {
    code: 28052,
    message: '该报名已处于终态(已发号/未通过/已撤销),无法撤销',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新证书审核闭环:急救资质/BSAFE 门槛标完成前须有对应类别证书图。
  RECRUITMENT_CERTIFICATE_IMAGE_REQUIRED: {
    code: 28053,
    message: '请先上传对应证书图片后再标记门槛完成',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 招新证书闭环刀A(2026-07-13):
  // - 28054:申请人不得覆盖已 approved 类别;管理员驳回后图片与门槛清除,上传自然复通。
  // - 28055:直接/批量标证书类门槛须先有对应类别 approved 审核结论;清标不受影响。
  RECRUITMENT_CERTIFICATE_ALREADY_APPROVED: {
    code: 28054,
    message: '该类证书已审核通过,如需更换请联系管理员',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_CERTIFICATE_NOT_APPROVED: {
    code: 28055,
    message: '该类证书尚未审核通过,无法标记门槛完成',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 招新可用性收口 F1(2026-07-11;评审稿 §2.5/E-U-1):
  // - 28060:付费 OCR 按 IP 北京自然日封顶(recognize + submit 共享;env RECRUITMENT_OCR_DAILY_IP_LIMIT
  //   默认 30;持久化计数表,重启不清零;HTTP 429 语义,独立于 @RecruitmentThrottle 限流器)。
  RECRUITMENT_OCR_DAILY_LIMIT: {
    code: 28060,
    message: '今日证件识别次数已达上限,请明日再试;如有疑问请联系管理员',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
  },

  // ===== 招新证书申报(Claim)业务级 —— 证书标准库 PR-4a(冻结稿 §18)=====
  //
  // §18 指定用「空闲 28056+ 号位」。已 grep 真源确认 28056-28059 与 28061+ 均空闲
  // (280xx 现用至 28055,再往上是 28060 OCR 日限)。
  RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND: {
    code: 28056,
    message: '证书申报不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID: {
    code: 28057,
    message: '证书申报状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT: {
    code: 28058,
    message: '证书申报已更新,请刷新后重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §8.1:每个报名最多保留 10 条未软删 Claim ——
  // 防公开上传端点被当成无限存储入口。
  RECRUITMENT_CERTIFICATE_CLAIM_LIMIT: {
    code: 28059,
    message: '本次报名的证书申报数量已达上限',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §8.3 APPROVE 第 3 步:审核通过必须解析到具体 CREDENTIAL Standard,
  // 不允许「不确定」状态直接过审(D-CERT-014 / D-CERT-015)。
  RECRUITMENT_CERTIFICATE_STANDARD_REQUIRED: {
    code: 28061,
    message: '审核通过前必须选定具体证书标准',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // §11.2:Standard 可以「已收录、暂无 ACTIVE Policy」——
  // 那种标准可被建议、可进待认定队列,但**不能**据此过审。
  RECRUITMENT_CERTIFICATE_POLICY_UNAVAILABLE: {
    code: 28062,
    message: '该证书标准尚无生效认定规则,无法通过审核',
    httpStatus: HttpStatus.CONFLICT,
  },
  // §8.4:redCross / bsafe 自本刀起是 Claim 的**只读派生投影**,
  // 单条与批量 markThreshold 传这两个 code(无论 completed 真假)一律拒。
  // 这是行为变更:此前它们是可人工标记的门槛。
  RECRUITMENT_THRESHOLD_DERIVED_READONLY: {
    code: 28063,
    message: '该门槛由证书申报审核结论自动派生,不可人工标记',
    httpStatus: HttpStatus.CONFLICT,
  },

  // team-join 招新三期(入队:志愿者→队员)业务级(282xx)。T2 引入(2026-06-19)。
  // 冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md §3.3 / E-J-8;新开 282xx 子段
  // (招新域 280xx-290xx 预留内,与 phase-1/2 的 280xx/281xx 物理分组)。
  //
  // 子段:
  // - 28201/28202:NOT_FOUND(入队轮 / 入队申请)
  // - 28203:唯一约束冲突(同轮同人活跃申请去重;partial unique P2002 兜底,T3)
  // - 28210:已入队(member 已有部门/级别,非新志愿者;T3 自助 create 前置)
  // - 28211:有 live 申请时,非 final join 的写方不得改动「未入队志愿者」身份(M2 唯一 transition)
  // - 28230:无 open 入队轮(T3 自助 create 前置);28231:开轮唯一性冲突(十项收口刀B)
  // - 28240:状态机闸(标 gate / 综合评估 / 改候选目标态不符);28243:gate 完成日在未来(十项收口刀A)
  // 候选/选定部门 org 存在+ACTIVE 校验复用既有 ORGANIZATION_NOT_FOUND / ORGANIZATION_INACTIVE(不另开码)。
  // - 28241:一键入队兜底重校验失败(approved 后通用门槛/贡献值过期;T4)
  // - 28242:选定部门不在候选 / 选了专业队但对应 team-* gate 未过(T4)
  // 不开 281xx-style FORBIDDEN_*(权限拒绝走通用 30100/40300,沿 phase-1 §3.3);
  // grade-code-invalid 走既有 MEMBER_GRADE_CODE_INVALID(level-1 seed 缺失时,理论不发生)。
  TEAM_JOIN_CYCLE_NOT_FOUND: {
    code: 28201,
    message: '入队轮不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  TEAM_JOIN_APPLICATION_NOT_FOUND: {
    code: 28202,
    message: '入队申请不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  TEAM_JOIN_DUPLICATE_APPLICATION: {
    code: 28203,
    message: '本轮你已发起入队申请,请勿重复发起',
    httpStatus: HttpStatus.CONFLICT,
  },
  TEAM_JOIN_MEMBER_ALREADY_ENROLLED: {
    code: 28210,
    message: '你已在队(已有部门/级别),无需再次入队',
    httpStatus: HttpStatus.CONFLICT,
  },
  // M2(并发复审 P1,2026-08-01):「未入队志愿者」身份是入队申请**唯一**的可走通前提。
  // 除 final join 外的任何写方把它改掉,都会让该队员名下的 live 申请变成 frozen 行 ——
  // evaluate 还能把它推到 approved,而 final join 从此永远 28210,再没有现存终态通路。
  // 拍板(2026-08-01)取「拒绝」:不自动终结、不静默放行,把选择权交回管理员。
  TEAM_JOIN_MEMBER_HAS_LIVE_APPLICATION: {
    code: 28211,
    message: '该队员有进行中的入队申请,请先完成一键入队或综合评估淘汰,再改动其身份/部门',
    httpStatus: HttpStatus.CONFLICT,
  },
  TEAM_JOIN_CYCLE_NOT_OPEN: {
    code: 28230,
    message: '当前没有开放的入队轮',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 十项收口刀B(2026-07-11):开轮唯一性冲突专码(镜像 28032;原 count 预检抛通用 40000)。
  TEAM_JOIN_CYCLE_OPEN_CONFLICT: {
    code: 28231,
    message: '已存在开放中的入队轮,请先关闭后再开启',
    httpStatus: HttpStatus.CONFLICT,
  },
  TEAM_JOIN_APPLICATION_WRONG_STATE: {
    code: 28240,
    message: '该入队申请当前状态不允许此操作',
    httpStatus: HttpStatus.CONFLICT,
  },
  TEAM_JOIN_GATES_NOT_SATISFIED: {
    code: 28241,
    message: '入队门槛或贡献值已不满足,无法入队(请重新核对)',
    httpStatus: HttpStatus.CONFLICT,
  },
  TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE: {
    code: 28242,
    message: '选定部门不在候选范围,或专业队考核未通过,无法入队',
    httpStatus: HttpStatus.CONFLICT,
  },
  // 十项收口刀A(2026-07-11):gate 完成日不得晚于当天(北京日口径,允许"今天"拒"明天")——
  // 此前可填未来日期立即判满足并当场自动推进(years 类还会把有效期虚推更远);extendedUntil 本义
  // 即未来日期,不受此闸。
  TEAM_JOIN_GATE_COMPLETION_IN_FUTURE: {
    code: 28243,
    message: 'gate 完成日期不能晚于今天',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // content 模块业务级(290xx)。CMS 内容发布模块(第 28 模块)引入(2026-06-21;评审稿 §7)。
  // 段位选择:baseline §1.1 原 "270xx-290xx 未规划预留" 末段,本期实装收口。
  // 附件类错误(MIME / 大小 / PII / owner)复用既有 13xxx(经 AttachmentsService 写路径),不在此新增;
  // 搜索 / 标签为查询参数,非法走通用 400(BAD_REQUEST),无专用码。291xx 权限边界预留(RBAC 统一 30100)。
  CONTENT_NOT_FOUND: {
    code: 29001,
    message: '内容不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  CONTENT_TYPE_INVALID: {
    code: 29010,
    message: '内容类型无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CONTENT_VISIBILITY_INVALID: {
    code: 29011,
    message: '可见级无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CONTENT_VISIBLE_ORG_INVALID: {
    code: 29012,
    message: '指定可见部门无效(为空 / 不存在 / 非活跃)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  CONTENT_INVALID_STATUS_TRANSITION: {
    code: 29030,
    message: '内容状态流转不允许',
    httpStatus: HttpStatus.CONFLICT,
  },
  CONTENT_ATTACHMENT_IN_USE: {
    code: 29031,
    message: '附件仍被内容封面或正文引用,请先移除引用',
    httpStatus: HttpStatus.CONFLICT,
  },

  // notification 模块业务级(310xx)。统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)引入
  // (2026-06-25;冻结评审稿 unified-notification-dispatcher-review.md §9.3 + member-notification-review.md §5)。
  // 段位选择:permissions 30xxx 之后顺延,baseline §1.1「未规划预留」收口首段;镜像 content 290xx。
  // app 详情 / mark-read 对不存在 / 不可见统一 31001 防枚举;DTO 白名单非法走通用 400 无码;
  // 311xx 权限边界预留(暂不用,RBAC 拒绝统一走 30100)。
  NOTIFICATION_NOT_FOUND: {
    code: 31001,
    message: '通知不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  NOTIFICATION_TYPE_INVALID: {
    code: 31010,
    message: '通知类型无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  NOTIFICATION_VISIBILITY_INVALID: {
    code: 31011,
    message: '可见级无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  NOTIFICATION_VISIBLE_ORG_INVALID: {
    code: 31012,
    message: '指定可见部门无效(为空 / 不存在 / 非活跃)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // 统一通知 S5 短信兜底渠道(2026-06-27;评审稿 unified-notification-dispatcher-review.md §4):
  // admin 显式发起短信的前置校验码——通知须为 published 且 channels 声明含 'sms'(紧急召集兜底意图);
  // 否则不可发短信(31013)。通道未配置走既有 SMS_CHANNEL_NOT_CONFIGURED(24030);confirmed 缺失走通用 400。
  NOTIFICATION_SMS_NOT_SENDABLE: {
    code: 31013,
    message: '通知不可发送短信(须为已发布状态且已声明短信渠道)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  NOTIFICATION_INVALID_STATUS_TRANSITION: {
    code: 31030,
    message: '通知状态流转不允许',
    httpStatus: HttpStatus.CONFLICT,
  },

  // organization positions + position rules 模块业务级(32xxx)。终态 scoped-authz PR3「职务定义」引入
  // (2026-07-01;冻结稿 §3.2 / §3.3 / §7.2)。纯配置面 CRUD;段位沿"31xxx 之后顺延"新开 32xxx。
  // 子段:
  // - 320xx:职务定义(position)—— 32001 NOT_FOUND / 32002 code 撞唯一(P2002 兜底)/ 32003 被规则引用禁删
  // - 3201x:职务规则(position-rule)—— 32010 NOT_FOUND / 32011 (nodeType,position) 撞唯一(P2002)/ 32012 nodeTypeCode 非法
  // positionId 引用不存在的职务复用 POSITION_NOT_FOUND(32001)。删除守卫沿 ORGANIZATION_HAS_CHILDREN 范式。
  POSITION_NOT_FOUND: {
    code: 32001,
    message: '职务定义不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  POSITION_CODE_DUPLICATE: {
    code: 32002,
    message: '职务 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  POSITION_IN_USE: {
    code: 32003,
    message: '职务已被职务规则引用,无法删除',
    httpStatus: HttpStatus.CONFLICT,
  },
  POSITION_RULE_NOT_FOUND: {
    code: 32010,
    message: '职务规则不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  POSITION_RULE_ALREADY_EXISTS: {
    code: 32011,
    message: '该组织类别对该职务已有规则',
    httpStatus: HttpStatus.CONFLICT,
  },
  POSITION_RULE_NODE_TYPE_INVALID: {
    code: 32012,
    message: '组织节点类别(nodeTypeCode)无效',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // - 3202x:任职(position-assignment)—— 终态 scoped-authz PR4「任职」引入(2026-07-01;冻结稿 §3.4 / §7.3 / §4.3)。
  //   任命校验失败清晰归码;memberId/organizationId/positionId 引用不存在分别复用 MEMBER_NOT_FOUND(20001)/
  //   ORGANIZATION_NOT_FOUND(19001)/ POSITION_NOT_FOUND(32001)。**任职 = 数据 + 任命校验,绝不进判权路径**。
  //   32020 NOT_FOUND / 32021 同人同组织同职务撞唯一(P2002 兜底)/ 32022 该 org 类别不可设此职务(无 active 规则)/
  //   32023 单人独占(allowMultiple=false 已有在任)/ 32024 兼任禁止(allowConcurrent=false 已有其它在任)/
  //   32025 需先有本组织或其祖先 active 归属(requireMembership=true)/ 32026 任期非法(endedAt≤startedAt)/
  //   32027 任职已结束/撤销,无法再次撤销。
  POSITION_ASSIGNMENT_NOT_FOUND: {
    code: 32020,
    message: '任职记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  POSITION_ASSIGNMENT_ALREADY_EXISTS: {
    code: 32021,
    message: '该成员在此组织的该职务已有在任任职',
    httpStatus: HttpStatus.CONFLICT,
  },
  POSITION_ASSIGNMENT_RULE_NOT_MATCHED: {
    code: 32022,
    message: '该组织类别不可设置此职务(无对应职务规则)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  POSITION_ASSIGNMENT_SINGLE_HOLDER: {
    code: 32023,
    message: '该职务不允许多人在任,已有在任者',
    httpStatus: HttpStatus.CONFLICT,
  },
  POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN: {
    code: 32024,
    message: '该职务不允许兼任,该成员已有其它在任任职',
    httpStatus: HttpStatus.CONFLICT,
  },
  POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED: {
    code: 32025,
    message: '任此职务须先在本组织或其上级有在任归属',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  POSITION_ASSIGNMENT_TENURE_INVALID: {
    code: 32026,
    message: '任期止必须晚于任期起',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  POSITION_ASSIGNMENT_ALREADY_ENDED: {
    code: 32027,
    message: '任职已结束或已撤销,无法再次撤销',
    httpStatus: HttpStatus.CONFLICT,
  },

  // - 330xx:分管(supervision-assignment)—— 终态 scoped-authz PR5「分管」引入(2026-07-01;冻结稿 §3.5 / §7.4 / §4.3)。
  //   分管 = 与职务正交的独立范围监督关系;create 绝不要求 supervisor 持职务。
  //   supervisor 引用不存在/非 active 复用 MEMBER_NOT_FOUND(15001)/ MEMBER_INACTIVE(17030);
  //   organization 引用不存在/非 active 复用 ORGANIZATION_NOT_FOUND(11001)/ ORGANIZATION_INACTIVE(17031);
  //   scopeMode 非法(∉ {EXACT,TREE})由 DTO @IsEnum → 通用 400,不另开码。
  //   33001 NOT_FOUND / 33002 同人对同组织撞唯一 active(P2002 兜底)/ 33003 任期非法(endedAt≤startedAt)/
  //   33004 分管已结束/撤销,无法再次撤销。**分管 = 数据 + 展示,绝不进判权路径**。
  SUPERVISION_ASSIGNMENT_NOT_FOUND: {
    code: 33001,
    message: '分管记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  SUPERVISION_ALREADY_EXISTS: {
    code: 33002,
    message: '该成员对此组织已有在任分管',
    httpStatus: HttpStatus.CONFLICT,
  },
  SUPERVISION_ASSIGNMENT_TENURE_INVALID: {
    code: 33003,
    message: '任期止必须晚于任期起',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  SUPERVISION_ASSIGNMENT_ALREADY_ENDED: {
    code: 33004,
    message: '分管已结束或已撤销,无法再次撤销',
    httpStatus: HttpStatus.CONFLICT,
  },

  // - 340xx:角色绑定(role-binding)—— 终态 scoped-authz PR6「RoleBinding」引入(2026-07-01;冻结稿 §3.6 / §7.5 / §4.3)。
  //   带 scope 的角色绑定管理面(GLOBAL/ORGANIZATION/ORGANIZATION_TREE/ACTIVITY/RESOURCE/SELF)。
  //   principalId 多态无 FK,按 principalType 校验存在性:USER 引用不存在复用 USER_NOT_FOUND(10001)/
  //   MEMBER 复用 MEMBER_NOT_FOUND(15001)/ POSITION_ASSIGNMENT 复用 POSITION_ASSIGNMENT_NOT_FOUND(32020);
  //   roleId 引用不存在/已软删复用 ROLE_NOT_FOUND(30003)/ ROLE_DELETED(30005);
  //   scopeOrgId 引用不存在复用 ORGANIZATION_NOT_FOUND(11001);scopeActivityId 引用不存在复用 ACTIVITY_NOT_FOUND(12001)。
  //   34001 NOT_FOUND / 34002 撞唯一 active(P2002 兜底,全 scope 维度)/ 34003 scope 字段与 scopeType 不匹配 /
  //   34004 principalId 与 principalType 不匹配(非 SYSTEM 缺 principalId 等)/ 34005 任期非法(endedAt≤startedAt)/
  //   34006 系统托管角色禁止通过通用入口人工维护。
  //   **🔴 scoped 绑定入库即止,RbacService 只读 scopeType=GLOBAL、绝不判 scoped**(判权是 PR8 AuthzService)。
  ROLE_BINDING_NOT_FOUND: {
    code: 34001,
    message: '角色绑定不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ROLE_BINDING_ALREADY_EXISTS: {
    code: 34002,
    message: '相同 principal × 角色 × scope 的在任绑定已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  ROLE_BINDING_SCOPE_INVALID: {
    code: 34003,
    message: 'scope 字段与 scopeType 不匹配(缺必填 scope 或提供了多余 scope)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ROLE_BINDING_PRINCIPAL_INVALID: {
    code: 34004,
    message: 'principalId 与 principalType 不匹配(非 SYSTEM 主体必须提供 principalId)',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ROLE_BINDING_TENURE_INVALID: {
    code: 34005,
    message: '任期止必须晚于任期起',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ROLE_BINDING_SYSTEM_MANAGED_ROLE_FORBIDDEN: {
    code: 34006,
    message: '该角色由业务流程自动维护，不能手工分配或撤销',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // - 350xx:活动评价(activity-feedbacks)—— 审计刀 6 第三件 F2(2026-07-16;冻结稿 §4.2)。
  //   评价资格只认 approved Sheet 内 live AttendanceRecord；活动必须 completed，窗口按
  //   Activity.endAt + ATTENDANCE_FEEDBACK_WINDOW_DAYS。DTO 的 rating/comment 边界仍走通用 40000。
  //   partial unique 首次并发撞 P2002 → 35002；三种业务闸给 App 精确按钮提示。
  ACTIVITY_FEEDBACK_ALREADY_EXISTS: {
    code: 35002,
    message: '该活动评价已存在，请刷新后重试',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED: {
    code: 35030,
    message: '活动尚未完结，暂不能评价',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_FEEDBACK_WINDOW_CLOSED: {
    code: 35031,
    message: '活动评价窗口已关闭',
    httpStatus: HttpStatus.CONFLICT,
  },
  ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED: {
    code: 35032,
    message: '仅有审核通过到场记录的队员可以评价',
    httpStatus: HttpStatus.CONFLICT,
  },

  // - 360xx:企业微信接入(wecom)—— T2(2026-08-01;冻结稿
  //   docs/archive/reviews/wecom-integration-t0-terminal-review.md §11.2)。
  //   本刀只落 T2 用得上的 3 条(36020 / 36030 / 36031);
  //   36002 / 36010 / 36011 属 T3(OAuth 与绑定)—— 段位在冻结稿 §11.2 已排好,不提前占码。
  //
  //   ⚠️ 命名与 250xx(微信**小程序**)严格分家:企业微信是另一个外部主体,
  //   共用错误码会让运维分不清"是小程序挂了还是企业微信挂了"(冻结稿命名铁律)。
  //
  //   不开的码(§11.2「不开」段,逐条都是防侧写或防污染):
  //   - WECOM_NOT_BOUND:GET 返状态对象、clear 幂等,没有"未绑定"这个错误场景
  //   - WECOM_USER_DISABLED:公开登录统一 36010 —— 区分开就是账号状态探测器
  //   - WECOM_EXTERNAL_USER:无内部 UserId 同样统一 36010
  //   - 发送失败码:异步落 Delivery/Outbox 状态,不污染 HTTP 业务端点
  //
  //   复用既有码:phone/短信无效仍 24010;P2002 身份冲突映射 36002(T3);
  //   限流仍 42900;权限拒绝仍 30100;settings DTO 无效仍 40000。
  //
  //   T3(2026-08-02)补齐 §11.2 表内其余 3 条(36002 / 36010 / 36011),段位与 T2 排定一致。
  //   36010 是**防侧写归一码**:state 无效 / code 无效 / 上游返 openid 或 external_userid /
  //   跨企业 `CorpId/userid` / 绑定指向 DISABLED 或软删 User / 锁后 identity 校验失败,
  //   对外**逐字段同形**。任何一条单独开码,登录接口就成了账号存在性与状态探测器
  //   (冻结稿 §6.2 规则 5 / §11.2「不开」段)。
  WECOM_IDENTITY_ALREADY_BOUND: {
    code: 36002,
    message: '该企业微信身份已绑定其他账号',
    httpStatus: HttpStatus.CONFLICT,
  },
  WECOM_LOGIN_CREDENTIAL_INVALID: {
    code: 36010,
    message: '企业微信登录凭证无效或已过期，请重新发起登录',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  WECOM_BINDING_TICKET_INVALID: {
    code: 36011,
    message: '绑定会话无效或已过期，请重新发起企业微信登录',
    httpStatus: HttpStatus.UNAUTHORIZED,
  },
  WECOM_CORP_ID_IN_USE: {
    code: 36020,
    message: '已存在企业微信绑定，不能修改 CorpID',
    httpStatus: HttpStatus.CONFLICT,
  },
  WECOM_CHANNEL_NOT_CONFIGURED: {
    code: 36030,
    message: '企业微信通道未配置或未启用',
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
  },
  WECOM_API_FAILED: {
    code: 36031,
    message: '企业微信服务暂时不可用，请稍后重试',
    httpStatus: HttpStatus.BAD_GATEWAY,
  },

  // audit_logs 模块业务级(140xx + 141xx)。批次 6 PR #1 引入(2026-05-12)。
  // 详见 docs:批次6_audit_logs_API前评审.md(D6 v1.1)§9。
  // 段位选择:baseline §1.1 v0.5 "audit_logs 140xx + 141xx" 基线预留,本批次实装收口。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 14001:NOT_FOUND(GET /:id 命中但不存在)
  // - 14101:已通过 audit-log.read.entry 入口权限,但 detail 超出统一读取范围
  //
  // 不开的码(D6 v1.1 §9 明确):
  // - 14002+:无唯一约束(audit_logs 写入后不可改不可删,无 P2002 场景)
  // - 14010+:无入参业务级校验(QueryDto 由 ValidationPipe 兜底走 BAD_REQUEST / 40000)
  // - 14102+:沿 baseline 保留
  //          14101 仅用于 Service 层"已通过 RBAC 入口、但 detail 超出范围"场景
  AUDIT_LOG_NOT_FOUND: {
    code: 14001,
    message: '审计记录不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  FORBIDDEN_AUDIT_LOG_READ: {
    code: 14101,
    message: '无权查看该审计记录',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // V2.x C-6 RBAC 实施 PR #2(2026-05-14):permissions 模块段位 300xx 实装。
  //
  // 段位归属(沿 baseline §1.1 / D7 v1.1 §12 / F1 v0.2 锁):
  // - 300xx:RBAC 模块通用错误(本 PR 实装 3 个:30001 / 30002 / 30008)
  // - 301xx:RBAC 权限 / 边界错误(本 PR 不实装,留 PR #5 角色分配 / PR #6 judge 实施时按需追加)
  //
  // 本 PR 实装的码(D7 v1.1 §12.1):
  // - 30001:权限点不存在(NOT_FOUND;findFirst → null 时抛)
  // - 30002:code 撞唯一约束(CONFLICT;P2002 兜底,DTO @MaxLength + Service @Matches 已前置拦截大部分)
  // - 30008:code 格式不合法(BAD_REQUEST;Service 层显式 regex 校验,
  //         不依赖 DTO @Matches — 让本码真正可触发并被 e2e 覆盖)
  //
  // 不开的码(留后续 PR 实装):
  // - 30000 RBAC_BAD_REQUEST(通用,留 PR #6 judge 用)
  // - (30003-30007 / 30009 Role/UserRole 相关已在 RBAC PR #3-#5 实装,详见下方对应段)
  // - 30010+ 其他(本 PR 不预占)
  // - (301xx 全段:30100 RBAC_FORBIDDEN / 30101 LAST_OPS_ADMIN_PROTECTED 已实装,详见下方对应段)
  PERMISSION_NOT_FOUND: {
    code: 30001,
    message: '权限点不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  PERMISSION_CODE_ALREADY_EXISTS: {
    code: 30002,
    message: '权限点 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  INVALID_PERMISSION_CODE_FORMAT: {
    code: 30008,
    message: '权限点 code 格式不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // V2.x C-6 RBAC 实施 PR #3(2026-05-14):RbacRole CRUD 段 3 码实装。
  //
  // 30003 / 30004 / 30005 实装规则(沿 D7 v1.1 §12.1 + 用户拍板):
  // - GET /api/system/v1/roles/:id:
  //   - 完全不存在 id → 30003 ROLE_NOT_FOUND
  //   - 存在但 deletedAt != null → 30005 ROLE_DELETED(410 Gone;detail 精确告知"曾在已删")
  // - PATCH / DELETE /api/system/v1/roles/:id:
  //   - 不存在 + 已软删统一返 30003
  //     (沿 docs/reference/soft-delete-transactions.md §10 信息泄漏防御,不告知曾在过)
  // - POST /api/system/v1/roles:code 撞唯一约束(含软删历史)→ 30004(P2002 兜底 + 预检查)
  //
  // 已在 RBAC 后续 PR 实装的相关码:
  // - (30006 USER_ROLE_ALREADY_EXISTS / 30007 USER_ROLE_NOT_FOUND 已在 UserRole CRUD 实装,详见下方对应段)
  // - 30009 INVALID_ROLE_CODE_FORMAT(本 PR 沿 30008 范式:Service regex 校验失败抛 30009)
  //   → 实装于本 PR,sole code 格式校验
  ROLE_NOT_FOUND: {
    code: 30003,
    message: '角色不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ROLE_CODE_ALREADY_EXISTS: {
    code: 30004,
    message: '角色 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  ROLE_DELETED: {
    code: 30005,
    message: '角色已删除',
    httpStatus: HttpStatus.GONE,
  },
  INVALID_ROLE_CODE_FORMAT: {
    code: 30009,
    message: '角色 code 格式不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // V2.x C-6 RBAC 实施 PR #4(2026-05-14):RolePermission 关联表段 1 码实装。
  //
  // 30011 实装规则(沿用户拍板;D7 v1.1 §12 未定义,本 PR 段内增量,沿 baseline §1.3
  // XX010-XX029 业务级输入校验段位语义):
  // - DELETE /api/system/v1/roles/:id/permissions/:permissionId:
  //   - role 不存在 / 已软删 → 30003 / 30005(沿 RbacRole CRUD;复用)
  //   - permission 不存在 → 30001(沿 Permission CRUD;复用)
  //   - role 与 permission 都存在,但 (roleId, permissionId) 关系不存在 → 30011(新增)
  // - POST /api/system/v1/roles/:id/permissions:沿用户拍板**幂等成功**,
  //   重复授权静默跳过,**不**抛 30010 ROLE_PERMISSION_ALREADY_EXISTS
  //
  // 30010-30019 子段位预留 RolePermission 业务级输入校验(本 PR 仅占 30011;
  // 30010 不开,留未来"严格模式重复授权报错"等场景按需追加)
  ROLE_PERMISSION_NOT_FOUND: {
    code: 30011,
    message: '角色未持有此权限点',
    httpStatus: HttpStatus.NOT_FOUND,
  },

  // V2.x C-6 RBAC 实施 PR #5(2026-05-14):UserRole CRUD + Q7 角色分级 + ops-admin 保护。
  //
  // 30006 / 30007 实装规则(沿 D7 v1.1 §12.1 + 用户拍板):
  // - POST /api/system/v1/users/:userId/roles:
  //   - (userId, roleId) 已存在 → 30006 USER_ROLE_ALREADY_EXISTS(沿 D7 决议**报错**而非幂等,
  //     与 RolePermission 批量幂等不同 — 单次单角色,报错给前端更精确)
  // - DELETE /api/system/v1/users/:userId/roles/:roleId:
  //   - (userId, roleId) 关系不存在 → 30007 USER_ROLE_NOT_FOUND
  //
  // 30101 / 30102 实装规则(沿 D7 v1.1 §12.2 + §6.2 + §6.3):
  // - 30101 LAST_OPS_ADMIN_PROTECTED:DELETE 撤销 ops-admin 角色时,事务内 count 剩余活跃
  //   ops-admin 持有者数 ≥ 1,否则抛 30101
  //   (沿 docs/reference/roles-admin-protection.md §13 最后一个 SUPER_ADMIN 保护范式)
  // - 30102 CANNOT_ASSIGN_HIGHER_ROLE:沿 §6.2 Q7 角色分级 C2 中庸方案:
  //   - SUPER_ADMIN(系统级)→ 通过任何
  //   - actor 持有 ops-admin(RBAC 角色)→ 可分配/撤销非 ops-admin 目标
  //   - 其他(ADMIN / 仅业务角色 / USER)→ 30102
  //   - dept-chief / dept-deputy 层级 placeholder seed 下不实施,留 PR #6 + seed 真实名落地
  USER_ROLE_ALREADY_EXISTS: {
    code: 30006,
    message: '该用户已持有此角色',
    httpStatus: HttpStatus.CONFLICT,
  },
  USER_ROLE_NOT_FOUND: {
    code: 30007,
    message: '该用户未持有此角色',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  LAST_OPS_ADMIN_PROTECTED: {
    code: 30101,
    message: '系统必须保留至少一个活跃运营管理员',
    httpStatus: HttpStatus.CONFLICT,
  },
  CANNOT_ASSIGN_HIGHER_ROLE: {
    code: 30102,
    message: '无权分配或撤销该角色',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // F1(全仓 review #399,2026-06-20)+第一档安全收口 D2(2026-07-13):
  // role-permission.assign 控制面授码分级闸专属拒绝码。
  //
  // SA-only 保留码(user.update.role / 4×*-setting.reset.credentials / member.delete.record)
  // 在 seed 中有意不绑 biz-admin / ops-admin(仅 SUPER_ADMIN 短路)。
  // 2026-07-13 起闸扩为单一控制面谓词:上述保留码 ∪ rbac.* ∪ role-binding.*；
  // 非 SUPER_ADMIN 命中任一 → 本码(整批拒绝,不部分写入)。保留码单一来源:
  // src/modules/permissions/reserved-super-admin-permission-codes.ts。
  PERMISSION_RESERVED_SUPER_ADMIN_ONLY: {
    code: 30103,
    message: '该权限点仅超级管理员可分配',
    httpStatus: HttpStatus.FORBIDDEN,
  },
  // 第一档安全收口 D3(2026-07-13):7 个 seed 内置 RbacRole 是系统基座，任何身份(含
  // SUPER_ADMIN)均不得经 API 软删；自定义角色删除逻辑不变。保护清单唯一来源:
  // src/modules/permissions/protected-role-codes.ts。
  PROTECTED_ROLE_DELETE_FORBIDDEN: {
    code: 30104,
    message: '系统内置角色不允许删除',
    httpStatus: HttpStatus.CONFLICT,
  },

  // V2.x C-6 RBAC 实施 PR #6(2026-05-14):RbacService.can() 配套统一拒绝码。
  //
  // 沿 D7 v1.1 §F5 / §12.2 锁定:Service 层显式 `rbac.can(actor, action, resource?)` 调用,
  // 失败由**调用方**抛 `BizException(BizCode.RBAC_FORBIDDEN)`(`30100`);
  // RbacService 自身只返 boolean / RbacJudgeResult,不抛异常。
  //
  // **本 PR 使用范围**:GET /api/system/v1/rbac/me/permissions 入口本身不抛(任何登录用户均可访问);
  // RBAC_FORBIDDEN 段位预留,供后续 PR 接入业务模块判权时使用(沿 F9 仅新增 V2 接口启用)。
  // 暴露段位 + message 文案在本 PR 落地,**调用点**留后续 PR。
  RBAC_FORBIDDEN: {
    code: 30100,
    message: '无权执行此操作',
    httpStatus: HttpStatus.FORBIDDEN,
  },

  // V2.x C-7 attachments 实施 PR #3(2026-05-15):AttachmentTypeConfig CRUD 段位。
  //
  // 沿 D7 v1.0 §8.1 子段位规划 + baseline §1.1 attachments 模块预留 `130xx + 131xx`。
  // 13020-13029 子段为配置三表通用段;本 PR 实装 3 项(13020 NOT_FOUND / 13021 CODE_ALREADY_EXISTS /
  // 13023 INVALID_CODE_FORMAT);mime / size 子表段位号 13022 / 13024-13026 已实装(详见下方对应段)。
  // 跨表 IN_USE 引用约束(13030-13032)已由 V2.x Slow-6 PR 实装(详见下方 13030-13032 段)。
  ATTACHMENT_TYPE_CONFIG_NOT_FOUND: {
    code: 13020,
    message: '附件类型配置不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS: {
    code: 13021,
    message: '附件类型配置 code 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT: {
    code: 13023,
    message: '附件类型配置 code 格式不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // V2.x C-7 attachments 实施 PR #4(2026-05-15):AttachmentMimeConfig CRUD 段位。
  //
  // 沿 D7 v1.0 §8.1 子段位 13020-13029 配置三表通用段;PR #3 已实装 13020 / 13021 / 13023(type config),
  // 本 PR 继续 13022 / 13024 / 13025(mime config)。typeConfigId 不存在场景**复用 13020**(Q5 v1.0 拍板:
  // 沿信息泄漏防御 + 不开多余 _TYPE_NOT_FOUND 镜像码;
  // 沿 docs/reference/soft-delete-transactions.md §10)。
  // size config 段位号 13026 / 13027 已实装(详见下方对应段)。
  ATTACHMENT_MIME_CONFIG_NOT_FOUND: {
    code: 13022,
    message: '附件 MIME 配置不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ATTACHMENT_MIME_CONFIG_DUPLICATE: {
    code: 13024,
    message: '该附件类型下 MIME 已存在',
    httpStatus: HttpStatus.CONFLICT,
  },
  INVALID_ATTACHMENT_MIME_FORMAT: {
    code: 13025,
    message: '附件 MIME 格式不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },

  // V2.x C-7 attachments 实施 PR #5(2026-05-15):AttachmentSizeLimitConfig CRUD 段位。
  //
  // 沿 D7 v1.0 §8.1 子段位 13020-13029 配置三表通用段;PR #3 已实装 13020 / 13021 / 13023(type config),
  // PR #4 已实装 13022 / 13024 / 13025(mime config),本 PR 继续 13026 / 13027(size limit config)。
  // typeConfigId 不存在场景**复用 13020**
  // (沿 Q5 PR #4 + docs/reference/soft-delete-transactions.md §10 信息泄漏防御)。
  // 跨表 IN_USE 引用约束(13030-13032)已由 V2.x Slow-6 PR 实装(详见下方 13030-13032 段)。
  // 13028 / 13029 段位预留给本表未来扩展。
  ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND: {
    code: 13026,
    message: '附件尺寸限制配置不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS: {
    code: 13027,
    message: '该附件类型已有尺寸限制配置',
    httpStatus: HttpStatus.CONFLICT,
  },

  // V2.x Slow-6 跨表引用约束(2026-05-16):配置三表 softDelete / updateStatus → INACTIVE
  // 时禁止破坏既有 attachment 引用;沿 D7 v1.0 §8.1 段位预留 + 评审 §8.1 设计。
  // - 13030: type config IN_USE(由 attachment.ownerType = type.code 引用)
  // - 13031: mime config IN_USE(由 attachment.ownerType = type.code AND attachment.mime = mime 引用)
  // - 13032: size limit config IN_USE(通过 typeConfigId → typeConfig.code 由 attachment.ownerType 引用)
  // 检查范围:softDelete + updateStatus → INACTIVE 双路径对称(沿 Q-cross-3 A);
  // 普通 update(改文案 / 数值)不检查(沿 Q-cross-6 A)。
  // refCount > 0 时统一抛对应 BizCode;不在 message / extra 暴露引用数
  // (沿 Q-cross-impl-4 A;docs/reference/soft-delete-transactions.md §10 信息泄漏防御)。
  ATTACHMENT_TYPE_IN_USE: {
    code: 13030,
    message: '附件类型仍被附件引用,无法删除或停用',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTACHMENT_MIME_CONFIG_IN_USE: {
    code: 13031,
    message: '附件 MIME 配置仍被附件引用,无法删除或停用',
    httpStatus: HttpStatus.CONFLICT,
  },
  ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE: {
    code: 13032,
    message: '附件尺寸限制配置仍被附件引用,无法删除',
    httpStatus: HttpStatus.CONFLICT,
  },

  // V2.x L-1 系统级 MIME 黑名单显式 BizCode(2026-05-16):
  // 沿 D7-attachments v1.0 §8.1 设计 + §6.6 + Q3 v1.0 SYSTEM_MIME_BLOCKLIST + 用户 L-1 拍板。
  // 段位说明:评审稿 §8.1 原本规划 13031;因 V2.x Slow-6 PR #99 已占用 13031
  // 给 ATTACHMENT_MIME_CONFIG_IN_USE,故顺延至 13033(连续 13030/31/32 跨表 IN_USE 之后)。
  // 解决问题:13012 ATTACHMENT_MIME_NOT_ALLOWED 一码多义(系统级永久禁 vs 白名单未命中);
  // 拆出 13033 后,前端 / 运营可精确区分两种拒绝原因。
  // 实施范围(沿 L-1 方案 A):仅 attachments 上传校验链(create + upload-url)单独抛 13033;
  // **配置三表 attachment_mime_configs CRUD 不变**(沿 §6.6 + Q3 v1.0 fail-close 原设计)。
  ATTACHMENT_SYSTEM_MIME_BLOCKED: {
    code: 13033,
    message: '附件 MIME 类型在系统级黑名单中,不允许上传',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTACHMENT_STORAGE_OPERATION_PENDING: {
    code: 13034,
    message: '附件存储操作处理中,请稍后重试',
    httpStatus: HttpStatus.SERVICE_UNAVAILABLE,
  },

  // V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块业务级错误段位。
  //
  // 沿 D7-attachments v1.0 §8.1 子段位规划 + 用户 PR #6b 拍板 Q1-Q14:
  // - 13001 主表实体不存在
  //   (沿 docs/reference/soft-delete-transactions.md §10 信息泄漏防御:
  //    detail / update / delete 不存在或无权统一返此码)
  // - 13010-13013 业务级输入校验(ownerType / ownerId / mime / size)
  // - 13015 PII 检测拒绝(身份证号);13014 跳过(沿 v0.2 决议 DTO @MaxLength 走 40000)
  // - 13101 不实装(Q13 拍板:写路径 RBAC 失败复用 30100,读路径用 13001 信息泄漏防御)
  // - 13030 IN_USE 已由 V2.x Slow-6 PR 实装(详见上方 13030-13032)
  ATTACHMENT_NOT_FOUND: {
    code: 13001,
    message: '附件不存在',
    httpStatus: HttpStatus.NOT_FOUND,
  },
  ATTACHMENT_OWNER_TYPE_INVALID: {
    code: 13010,
    message: '附件归属类型不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTACHMENT_OWNER_NOT_FOUND: {
    code: 13011,
    message: '附件归属对象不存在或已软删',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTACHMENT_MIME_NOT_ALLOWED: {
    code: 13012,
    message: '附件 MIME 类型不在白名单',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTACHMENT_SIZE_EXCEEDED: {
    code: 13013,
    message: '附件大小超过上限',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // F2(全仓 review #399,2026-06-20):create()(模式 A)key 格式校验。
  // 客户端 raw key 必须落在「attachments 命名空间 + 当前 envPrefix + 服务端派生格式」内,
  // 否则可对命名空间外任意 COS 对象签 signed URL(IDOR)。校验源:
  // src/modules/attachments/attachment-key-format.ts(与 generateAttachmentKey 同源)。
  // 占 13010-13015 create 校验子段空位 13014。
  ATTACHMENT_KEY_INVALID: {
    code: 13014,
    message: '附件 key 格式不合法',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  ATTACHMENT_PII_DETECTED: {
    code: 13015,
    message: '附件元数据包含个人敏感信息(身份证号),已拒绝',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
  // v0.44.0 findings #22/#23/#24:confirm-upload 回读固定前缀,声明 MIME 与文件签名不符即拒绝。
  ATTACHMENT_CONTENT_TYPE_MISMATCH: {
    code: 13016,
    message: '附件内容与声明的 MIME 类型不符',
    httpStatus: HttpStatus.BAD_REQUEST,
  },
} as const;

export type BizCodeEntry = (typeof BizCode)[keyof typeof BizCode];
