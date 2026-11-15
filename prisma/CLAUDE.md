# Prisma — 模型、迁移与不可变事实

`schema.prisma` 是模型权威源，实际数据库约束还包括migration中的CHECK、partial unique和trigger。
历史迁移说明/计数不作为当前事实；旧全文可从 `harness-v3-final:prisma/CLAUDE.md` 查看，
部署与切换状态看 `docs/current-state.md`、`docs/ops/` 和实际环境证据。

## 变更边界

- 不自动运行migrate dev/reset/db push，不触碰默认/生产数据库。
  schema变更先说明影响的service/DTO/Swagger/contract与兼容策略。
  生产仅由维护者deploy已审查migration；代码已合并或隔离库通过不等于已部署。
- 已合入migration不可重写，修正追加新migration；命名YYYYMMDDHHMMSS_可读描述，不用auto/tmp/wip。
  不用@map/@@map擅改库表名，不引全局软删middleware/client extension。
- 数据删除、回填、真实旧规则转换、shadow/Gate开启各需明确授权，
  不因新表/约束已有就补运行时或自动迁移历史数据。
- CHECK须考虑PostgreSQL三值逻辑：NULL会通过CHECK，闭集/组合不变量应显式处理NULL，
  不靠另一列当前NOT NULL碰巧保证。只约束已定义的值域，不能从同名字段猜闭集。
  条件不可变（如batch committed后冻结）不等于无条件append-only；
  不用无锁跨行trigger假装解决并发，也不阻断合法preparing写链。

## 同链与历史保护

持多个业务锚的对象必须用复合FK证明同链，不只证明各ID存在。
冻结多锚记录（createdAt、无updatedAt）的复合FK须onUpdate:Restrict或有BEFORE UPDATE保护；
Prisma省略onUpdate默认Cascade，不能让上游改编号无痕改历史。
OfflinePackageParticipant四条既有约束名保持，别把已知RenameForeignKey差异当作可顺手修的命名。
结构检查 `scripts/check-composite-anchor-closure.ts` 不能代替真实PG交叉锚23503负例。

append-only事实/证明/收据按各表既有UPDATE/DELETE/TRUNCATE保护处理，不发明统一清理入口。
来源、政策/选择版本、正式成果、贡献账和更正证据永久留存；不能用当前配置重解释历史。
父子完整性、当前指针、exact source/hash、金额/数量、锁序与既有5/7/30秒预算不能为了性能放宽。
完整结果oracle与真实guard负例必须保留；局部快路径通过不等于满额或事务迟提交问题已解决。

## 易误改的模型语义

- 永久报名头全历史唯一，取消/拒绝只追加revision，软删不复活。
  revision与Evidence复合FK同头，legacy NULL evidence与revision evidence分别唯一；
  旧证据零回填，owner不增加evidenceId，不提供Evidence改删路径。
- Allocation receipt只安全信封，不是分配真值；DB验shape/列值/hash相等，不重算密码学hash。
  runtime按固定字段序activityId/allocationBatchId/batchStatusCode/commandCode/responseSchemaVersion
  的UTF-8 canonical payload算SHA-256，排除responseHash，不能依赖JSONB键序。
  allocated投影的三层reservation/pointer/population成套，其他结果清空；
  activity-person按member+activity锚可跨session复用，其余reservation按identity锚。
  waitlist rank仅batch+position内唯一，lotteryOrder/tieBreakKey仍全batch。
  这些表的迁移空表前置必须先count-only fail-fast，不偷偷回填绕过去。
- 保险Evidence不存自由文本/保单号/附件/key/URL/reviewer name；
  结构/FK/member-match与immutable触发器的错误优先级沿insurances模块规则，不随意调换。
- Outbox eventKey普通唯一；微信小程序、admin SMS、企业微信各有独立active partial unique，
  不能合为一条让同一收件人的不同渠道互斥。
- Shadow登记/运行身份分离，默认信任根NULL即拒写；来源只读、证据追加、原始audit拒读、
  runtime无旧考勤表写权。来源时点批准+不可变选择必须锁后复算，不接自填分或伪造时间。
  registration EXECUTE关闭不抹历史批准；合成夹具不证明真实映射或生产LOGIN已验收。
- Proof cutover用同一PG advisory shared/exclusive事务锁与普通ledger提交线性化；
  旧根账不回填/重分类，correction继承根制度。
  切换后binding由DB同事务生成，缺根清单/错锚整体回滚，不用应用补写替代。
- pending correction段只是暂存，prepare不创建正式段；commit核精确base后先superseded再物化，
  清理收据不可变、正式历史不删。
- Integration的Permission机器/委托资格默认false，delegated⇒service；
  SERVICE_PRINCIPAL枚举扩展与旧二进制回滚不兼容，不能把schema-only当运行时已启用。

## seed

默认SA及bootstrap GLOBAL USER binding沿现有契约。ops-admin seed与运行时共用任期真值，
完成后须同时存在当前有效holder与endedAt=null常驻holder；
已有ACTIVE slot不改任期，future/expired/仅临时配置fail-closed，重复seed不得改变任期。
生产启动仍严格校验SUPER_ADMIN_*、JWT_SECRET、APP_CORS_ORIGIN。

权限码不因通用角色摘权而删除；仅定点移除活动责任旧动作，不清无关自定义映射。
reviewer不自动建PositionRolePolicy。
结算generate/submit/close只owner，generate/submit可考勤协办，first/final-review各属对应reviewer；
五码仅在责任workflow seed upsert，不并入BIZ_PERMISSION_SEED，
同时位于biz-admin定点摘权集，seed不得凭重跑重新给通用角色结算权或自动建binding/policy。
Human目录新码沿明确的零默认授予清单，不扩大为整族豁免。

验证按变更选择schema/seed/约束与真实并发E2E，迁移需冷回放及非空升级证据；
命名、枚举、partial unique、复合FK与错误码以实际代码/SQL为准，不在本文件维护数量副本。
