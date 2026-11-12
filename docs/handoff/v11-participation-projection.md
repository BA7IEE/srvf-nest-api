# 新版活动对账、参与汇总和月度总览（本地候选）

本候选未合入、未部署；真实 PostgreSQL 和 HTTP 测试均未运行。`GET /api/admin/v1/activities/{activityId}/reconciliation`、`GET .../participation-summary` 与 `GET /api/admin/v1/meta/participation-overview` 不再读取旧 Sheet 考勤记录。

活动列表 `includeStats=true` 保留 `registrationCount`（未软删报名头的全部状态）；旧 `attendanceSheetCount` 已移除。具有审核台 GLOBAL 读取码及组织范围时才返回 `settlementStats`：开闸为 `available: true` 和曾提交、当前非 draft 的 `submittedVersionCount`（含退回和作废的历史提交，排除未提交即作废的草稿），关闸为 `available: false`，无权限则省略。该数字不是人数、到场或待办，前端须改字段；旧 E2E 断言待按合同审查。

工作台移除 `attendanceSheets`，改为按审核台 GLOBAL 读码及一审/终审 GLOBAL action 裁剪的 `settlementReviews`。开闸时相应字段计数授权组织内处于一审/终审状态的 run；数字不是本人可审核数。关闸时仅有权者得到 `available: false`，其他工作台块照常；无权块或阶段省略。

三个读面先保留既有两项读取权限及资源/组织范围；在同一个 `REPEATABLE READ` 快照中读取授权、活动、报名、身份、当前正式结算、已入账账本和正式时长。月度请求的组织后代展开也使用该事务。无可见组织的月度请求仍为空数组；其余新版关闭的请求返回 20153／503。只读维护态开启且新版工作流已启用时仍可读。

## 事实与人数

- 正式结果以活动 run 的 `currentPostedVersion` 对应 version、committed batch 和 committed result 为锚，不依赖 active closure 或账本金额大于零。更正准备时仍读原 posted 版本，正式切换后读新版本；锚点缺失、结果行数不符、跨活动身份或重复身份会失败，不静默当空值。
- 按活动×成员聚合多个场次：任一正式 `present` 即到场，即使工时和贡献均为零；没有 `present` 且有未决应结算场次则待定；全部相关正式结果为 `absent` 才是缺席；请假、取消、早退零值等其他正式结果单列。无结果且当前不属于应结算人口的身份不计待定；已经 posted 的结果不因后来移出人口或报名软删消失。通过报名但尚无相关身份也计为待定。
- `registrationCounts` 仍描述未软删报名头的现有状态；现场补录的报名头可能是 pending，而场次身份已 pass，不能用报名头 pass 数替代正式人口。`attendeeCount`、`noShowCount`、`pendingCount`、`otherResultCount` 是上述成员级结果，和旧 Sheet 行数口径不同；`pendingSessionCount` 另计未决身份，因此成员已在另一场次到场时，待定场次也不会被隐藏。
- 来源字段表达当前快照中**曾有的通过修订证据**：只有普通通过为 `registered`，只有 onsite 通过为 `onsite`，两者均有为 `mixed`，缺修订或有未知通过来源为 `unknown`。这不是“从未报名”的推断；现场补录可复用被拒的旧身份。身份修订在应用中追加，不声称数据库存在不可变触发器。活动汇总的 `registeredAttendeeCount`、`temporaryAttendeeCount`、`mixedOriginAttendeeCount`、`unknownOriginAttendeeCount` 四项按此划分正式到场成员；月度按活动人次分别求和。
- `attendanceRate` 是正式到场 / (正式到场 + 正式缺席)，没有已判定成员时为 `null`；待定和其他结果不进入分母。月度率仅累加 completed 活动的已判定人次，`averageAttendanceRate` 和 `noShowRate` 在无分母时均为 `null`。

## 数值与时间

- 贡献是所有 committed 批次的 credited 正负净额，含冲回和重记，不与旧 Sheet 相加、不二次封顶。
- 正式时间 receipt 存在时，工时使用统一 selector 的 eligible 秒；否则使用已入账工时净额。直方图的单位是活动×正式到场成员，已知零秒计入 `[0,2)`；缺少可验证时长的成员计入 `durationUnknownCount`，不进桶，并使总工时为 `null`。负数或无效秒数不会被夹为零。
- 月份仍按 `Activity.startAt` 的 UTC 月份，保留现有活动日期筛选边界；账本北京自然日不重新切分活动月份。正式秒先在月内累加再转小时，避免逐活动四舍五入误差。

## 对账响应变化

对账仍只允许 completed 活动。`passRegistrationCount` 是未软删 pass 报名头数；`attendedCount`、`noShowCount`、`pendingCount` 和 `otherResultCount` 是活动×成员级结果。`registeredParticipants`、`temporaryParticipants` 与新增 `unclassifiedParticipants` 分别按普通、现场、混合/未知通过修订来源分组；无身份的 pass 报名列入未知来源和待定。

每人 `sessions` 显示身份、当前状态、是否属于应结算人口、当前正式 `resultCode` 或 null、以及该身份当前正式版本的 `ledgerDayCount`。`recordCount` 现在是这些日行数之和（身份×北京日，包含合法零值），不是旧 Sheet 记录数；新增 `postedResultCount` 是有正式结果的身份数。旧 `approvedRecordCount` 对新版没有等价语义，已移除。`totalServiceHours` 缺少来源时为 null，正式时间优先。前端须按新响应调整，不能把旧 Sheet ID 或旧字段直接映射。

报名取消和重提在现有 Activity 根锁事务内检查同一报名身份的任意原始 PunchEvent（包括 void/replace）及 committed 结算结果（包括零值）；命中分别沿用原有 21033 或 21030。旧 Sheet / GPS 不再参与这一运行时判定，因此对未转换旧历史的拒绝集合与旧版不等价；本候选不迁移或删除历史数据，用户称系统尚无真实用户，实际数据库未核验。

活动软删在原 Activity 根锁内检查新版永久身份及结算 run；存在任一项即拒绝。它不再检查旧 Sheet 或 GPS，故仅有未转换旧 Sheet 的历史活动与旧版拒绝集合不同；不物理删除历史数据。

开放、无打卡或未入账不推成缺席；结算阶段性服务段和 punch 仍以各自新版接口查看。负责人工作流与遗留资源解析的旧依赖、入队达标通知、真实隔离 PG/HTTP、受保护合同和守卫审查仍未完成。
