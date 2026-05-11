import { HttpStatus } from '@nestjs/common';

// 完整 12 个 BizCode,1:1 对齐 ARCHITECTURE.md §7.3。
// 段位规则:4xxxx/5xxxx 通用 HTTP 级,100xx users 业务,101xx users 权限/边界,
// 后续模块按 110xx+ 平铺(见文档表)。
//
// 注:BizCode 是公共常量,不绑定具体业务模块,这一阶段一次性落地是合理的;
// 各业务码的实际 throw 点仍按"每次只实现一个阶段"在第 7/8 阶段补上。
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

  // member_departments 模块业务级(170xx + 171xx)。详见 docs/v2-api-contract.md §5.4。
  // 子段(对齐 baseline §1.3):
  // - 17001:NOT_FOUND(member 当前无 active 归属)
  // - 17002:唯一约束冲突(并发兜底,partial unique index 撞)
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

  // organizations 模块业务级(110xx + 111xx)。详见 docs/v2-api-contract.md §3.5。
  // 子段(对齐 baseline §1.3):
  // - 11001:NOT_FOUND
  // - 11010-11029:业务级输入校验(parent_not_found / node_type_invalid /
  //   parent_cycle / parent_change_forbidden)
  // - 11030-11099:资源状态非法 / 引用约束(has_children / has_members /
  //   root_already_exists)
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
  DICT_ITEM_PARENT_IMMUTABLE: {
    code: 12014,
    message: '字典项父级不允许修改',
    httpStatus: HttpStatus.BAD_REQUEST,
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
} as const;

export type BizCodeEntry = (typeof BizCode)[keyof typeof BizCode];
