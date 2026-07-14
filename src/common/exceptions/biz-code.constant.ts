import { HttpStatus } from '@nestjs/common';

// BizCode 常量表
//
// 当前状态(随实施滚动维护;每次新增模块码后校对):
// - 招新证书闭环刀A(2026-07-13):28xxx +2(28054 已审核通过禁止重传 / 28055 未审核通过禁止标门槛)
// - 232 个 BizCode(2026-07-13 亲核:Object.keys(BizCode).length;第一档 RBAC 安全收口新增 30104 后终值,本档 +0)
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
// - 编号段权威说明以 `docs/srvf-foundation-baseline.md §1.1` 为准;
//   ARCHITECTURE.md §7.3 是早期蓝图,模块命名已演进(missions→dictionaries、
//   files→attachments、devices→audit_logs 等),遇分歧以 baseline §1.1 + 本文件实际常量为准
// - 本文件是运行时代码唯一导出源(全仓 BizException throw 与 test 引用共 ~1700 处),
//   无明确迁移计划前不得拆分
//
// 治理约束:
// - 禁止复用已存在 code(新增前先 grep 数字是否撞段)
// - 禁止为同一语义新开重复码(优先复用既有码;沿 v1 §10 信息泄漏防御)
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
// - 40xxx / 42xxx / 50xxx: 通用 HTTP / infrastructure(BAD_REQUEST / UNAUTHORIZED / FORBIDDEN / NOT_FOUND / TOO_MANY_REQUESTS / INTERNAL_ERROR)
// - 未规划模块预留(训练 / 装备 / 财务等):33xxx 之后顺延(realname 27xxx / recruitment 28xxx / content 29xxx / notification 31xxx / position 32xxx / supervision 33xxx 已实装)
export const BizCode = {
  // 通用 HTTP 级
  BAD_REQUEST: { code: 40000, message: '请求参数错误', httpStatus: HttpStatus.BAD_REQUEST },
  UNAUTHORIZED: { code: 40100, message: '未登录或登录已失效', httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN: { code: 40300, message: '无权限访问', httpStatus: HttpStatus.FORBIDDEN },
  NOT_FOUND: { code: 40400, message: '资源不存在', httpStatus: HttpStatus.NOT_FOUND },
  // V1.1 §11.4 / TASKS.md 15.7:登录接口限流命中。落 4xxxx 通用 HTTP 段(429),
  // 不占用业务模块 100xx / 110xx 段。message 故意不暴露阈值数字、剩余配额、
  // 重置时间(防止攻击者反推限流参数)。
  TOO_MANY_REQUESTS: {
    code: 42900,
    message: '请求过于频繁，请稍后再试',
    httpStatus: HttpStatus.TOO_MANY_REQUESTS,
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
  // 段位归属:沿 v1 §5 BizCode 编码段:100xx 为 users 模块业务级(含 auth);
  // 已用 10001-10006(LOGIN_FAILED=10004 / OLD_PASSWORD_INVALID=10005 /
  // NEW_PASSWORD_SAME_AS_OLD=10006),10007 为下一可用号位。
  //
  // **不**拆 REFRESH_TOKEN_EXPIRED / REVOKED / REPLAY(沿评审稿 D-6 + v1 §8 防账号枚举):
  // refresh 失败的 4 种子原因(不存在 / 已撤销 / 已过期 / 重放命中)统一返 10007,
  // 响应体 / HTTP status / message 完全一致(防止攻击者据错误码反推 token 状态)。
  REFRESH_TOKEN_INVALID: {
    code: 10007,
    message: 'refresh token 无效或已过期',
    httpStatus: HttpStatus.UNAUTHORIZED,
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
  // 子段(对齐 baseline §1.3):
  // - 18001:NOT_FOUND
  // - 18010-18029:业务级输入校验(cert_type / cert_sub_type 字典 invalid)
  // - 18030-18099:资源状态非法 / 状态机转移非法
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
  // - 20001:NOT_FOUND
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
  ACTIVITY_STATUS_INVALID: {
    code: 20030,
    message: '活动当前状态不允许此操作',
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

  // activity_registrations 模块业务级(210xx + 211xx)。批次 3A 引入(2026-05-11)。
  // 详见 docs:批次3_API前评审决议表.md v1.0 §1.1 / §1.3 + §6.2。
  // 子段(对齐 baseline §1.3):
  // - 21001:NOT_FOUND(含 USER 越权访问他人 → 404,沿 §1.7 风格避免存在性泄漏)
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

  // attendances 模块业务级(220xx + 221xx)。批次 3B 引入(2026-05-11)。
  // 详见 docs:批次3_API前评审决议表.md v1.0 §1.8 / §1.14 + 批次3_schema草案 §18.2。
  // 子段(对齐 baseline §1.3):
  // - 22001-22009:Sheet NOT_FOUND
  // - 22030-22049:Sheet 状态机 / 资源状态(STATUS_INVALID / APPROVED_NOT_EDITABLE / REJECTED_NOT_EDITABLE)
  // - 22050-22099:Record 实体级(字典 / 时间 / serviceHours / contributionPoints / registrationId 跨表)
  // - 221xx:暂留(FORBIDDEN_ATTENDANCE_* 不开,沿 baseline;USER 越权 → 404 沿 §1.7)
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
  // same_reviewer 可经 env ATTENDANCE_ALLOW_SAME_REVIEWER=true 放开;自审永不可放开。
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

  // contribution_rules 模块业务级(230xx + 231xx)。批次 5-A 引入(2026-05-12)。
  // 详见 docs:批次5-A_贡献值规则CRUD_API前评审.md v1.1 §5(BizCode 锁定 紧凑版)+ §2.2 E3。
  // 段位选择:baseline §1.1 v0.4 "未规划模块从 230xx 起" → v0.5 收口段位归属为 contribution_rules。
  // 与 attendances 段(220xx)解耦:contribution_rules 是配置表 / 独立 module,不与 attendance 业务码混淆。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 23001:NOT_FOUND
  // - 23002:唯一约束冲突(`(activityTypeCode, attendanceRoleCode, durationThreshold)` ACTIVE 维度)
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
  // - 26030:报名门槛(T3 实装 INSURANCE_REQUIRED;409 沿 20120/21030 报名业务态冲突家族)
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
  // T3 报名门槛(评审稿 §3.3 落点表;过期与无保险不细分,前端提示价值无差,E-8;
  // 409 沿 20120/21030 报名业务态冲突家族;requiresInsurance=false 活动零查询不触发)。
  INSURANCE_REQUIRED: {
    code: 26030,
    message: '该活动要求保险,当前队员无覆盖活动日期的有效保险,不可报名',
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

  // team-join 招新三期(入队:志愿者→队员)业务级(282xx)。T2 引入(2026-06-19)。
  // 冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md §3.3 / E-J-8;新开 282xx 子段
  // (招新域 280xx-290xx 预留内,与 phase-1/2 的 280xx/281xx 物理分组)。
  //
  // 子段:
  // - 28201/28202:NOT_FOUND(入队轮 / 入队申请)
  // - 28203:唯一约束冲突(同轮同人活跃申请去重;partial unique P2002 兜底,T3)
  // - 28210:已入队(member 已有部门/级别,非新志愿者;T3 自助 create 前置)
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
  //   34004 principalId 与 principalType 不匹配(非 SYSTEM 缺 principalId 等)/ 34005 任期非法(endedAt≤startedAt)。
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

  // audit_logs 模块业务级(140xx + 141xx)。批次 6 PR #1 引入(2026-05-12)。
  // 详见 docs:批次6_audit_logs_API前评审.md(D6 v1.1)§9。
  // 段位选择:baseline §1.1 v0.5 "audit_logs 140xx + 141xx" 基线预留,本批次实装收口。
  //
  // 子段(对齐 baseline §1.3 紧凑使用):
  // - 14001:NOT_FOUND(GET /:id 命中但不存在)
  // - 14101:权限边界(ADMIN 越级查 SUPER_ADMIN 的 detail;D-D 拍板)
  //
  // 不开的码(D6 v1.1 §9 明确):
  // - 14002+:无唯一约束(audit_logs 写入后不可改不可删,无 P2002 场景)
  // - 14010+:无入参业务级校验(QueryDto 由 ValidationPipe 兜底走 BAD_REQUEST / 40000)
  // - 14102+:沿 baseline,USER 越权由 Guard 拒绝走通用 FORBIDDEN / 40300;
  //          14101 仅用于 Service 层"已通过 Guard、但 detail 越级"场景
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
  //   - 不存在 + 已软删统一返 30003(沿 v1 §10 信息泄漏防御,不告知曾在过)
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
  //   ops-admin 持有者数 ≥ 1,否则抛 30101(沿 v1 §13 最后一个 SUPER_ADMIN 保护范式)
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
  // 沿信息泄漏防御 + 不开多余 _TYPE_NOT_FOUND 镜像码;沿 v1 §10)。
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
  // typeConfigId 不存在场景**复用 13020**(沿 Q5 PR #4 + v1 §10 信息泄漏防御)。
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
  // refCount > 0 时统一抛对应 BizCode;不在 message / extra 暴露引用数(沿 Q-cross-impl-4 A;v1 §10 信息泄漏防御)。
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

  // V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块业务级错误段位。
  //
  // 沿 D7-attachments v1.0 §8.1 子段位规划 + 用户 PR #6b 拍板 Q1-Q14:
  // - 13001 主表实体不存在(沿 v1 §10 信息泄漏防御:detail / update / delete 不存在或无权统一返此码)
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
