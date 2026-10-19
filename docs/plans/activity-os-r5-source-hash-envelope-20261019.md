# R5 来源 hash 固定外层计算优化

当前为 D 档开发候选，隔离升级单次已执行但整体失败，未验收原满额、未部署。父任务 2026-10-19 明确将调查边界推进到本纯计算优化的实现及验证计划；仅 `astr_source_set_hash(text,text)` 的固定双键外层，保留原 document／canonical、锁、归属链、约束、触发器和预算。旧 v1/v2 完整记录编码／flags 字典候选继续弃用。新148的维护者 SQL 审阅及 Trusted 审批尚未取得，137–147既有签字不扩大至148。

2026-10-20（Asia/Shanghai）用户已明确批准冻结41路径包的精确正常CLI grant与四库条件验证。原CLI已登记仅该migration文件的grant，SQL摘要与送审值一致；不扩大到其他路径、3b、Ready、合并或生产。四库及操作清单见下，历史送审包和旧失败均保留。

## 影响与范围

| 项                                     | 结论                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| schema／model／enum／relation          | 均不变，196 个模型                                                                          |
| migration                              | 仅新增 `20261019184200_activity_source_hash_envelope_fast_path`，历史1–147逐字不改          |
| seed／Permission／Role／鉴权／审计定义 | 均不变，无 GRANT／REVOKE／SECURITY DEFINER／owner／search_path 变化                         |
| 现有业务数据                           | 无回填、转换、删除；历史及新增指纹的完整 UTF8 字节和 SHA 必须一致                           |
| 可逆性                                 | 一个 CREATE OR REPLACE 原子替换；后续回退须另加前向恢复迁移，不能改已应用历史或伪造迁移状态 |
| API／DTO／OpenAPI／BizCode／前端       | 均不变；既有来源归属、抗伪造和最终授权仍由原校验链承担                                      |
| 性能验收                               | 仍为原 30 秒事务、原数量与断言；只读阶段不能替代原生验收                                    |
| 本地 grant                             | 仅新增 migration 文件一个精确路径，按本轮用户明确委托调用正常 CLI；没有新增自主授权           |

原函数参与完整性指纹校验，输出是守卫输入；本次没有改变任何安全策略或输出语义。它仍是 SQL／STABLE、非 STRICT、调用者权限。固定外层 C 键序为 definition、domain，domain 与 JSON 标点固定；内部全部继续经现有 `astr_canonical_json(astr_source_set_document(...))`。SQL NULL document 经 coalesce 保持原 JSON null。migration SHA256：`bbde4b75459953641dd80a57d83a924b9b7e5068432b54847f08f1ee9f90914d`。

必要后果面：31 个 CURRENT_MIGRATION_COUNT 由147到148，仅声明当前总数，历史升级目标和业务断言不变；E4历史prefix新增精确148 successor，固定137证据prefix仍为137；fixture新增固定147部署入口，旧147验收从 latest 改指147，禁止间接把历史目标带到148。补充148独立迁移E2E、离线DDL范围检查、changelog及派生计数。schema不变，相关schema摘要无需刷新。

## 已有证据与局限

只读候选160项完整字节／hash对照通过，满额文档8184690 bytes，SHA为 `95d4c3d2ed8987f51a6f1f3bb5cf792892475b97bc82b0e6f130866c228dc26a`。只读计划 document调用1保持，canonical32002到32001，最外层两行排序消失，整条SELECT临时读／写各减少2180 blocks；内部十键排序和全部文档生成仍在。跨模型静态及证据审查0／0。顺序计时波动，不能宣称墙钟提升或原30秒一定能过。

旧2b05原满额在receipt报P2028，方法32263.771676ms；内部哪条校验完成仍UNKNOWN。旧quick窗口失败、N1 CI失败与其oracle失败保持。不得为此抬预算、重试求绿或恢复已延期AC。

## 验证顺序

1. 固定本提交与SQL/checksum；离线DDL范围、prefix、针对性lint及测试类型检查。
2. 在全新、精确批准的模板／w1库运行148独立E2E一次：真实非空147事实→148、历史checksums、所有业务行、其他函数／OID／属性／ACL／约束／触发器／索引／关键设置相同；再次migrate deploy无操作。
3. 相同隔离运行包括安装后完整UTF8 preimage及hash对照（SQL NULL／JSON null／未知形状／精度／转义／嵌套），真实新prepare，完整receipt对照主动回滚、伪造sourceSetHash的23514拒绝且业务快照相同，以及真实submit后的commit证明。
4. 另一个全新、精确批准的模板／w1库执行原普通R4十五项一次，仅排除两个已指明的大规模pattern；全部通过且资源终态明确后，原R4最大用例由该固定提交的默认PR CI计入一次，不再本地重复。CI还包括其他默认适用用例；历史E4最大/S13仍受原C1条件和独立选择限制，不因本计划启动。
5. 任一FAIL／UNKNOWN停止后续，保留原始退出、阶段及全部18旧库和新库。新库建库／迁移／worker重建／业务夹具／rollback演练及清理必须在精确批准操作清单内；预览与空库读数不等于授权。

计划不是执行凭据。实际worktree派生库名、命令、写操作、校验基点、批准来源和单次ledger放在执行包；未实际运行标 NOT_RUN。Draft PR准备须绑定最后SHA，保持Draft、不自动合并；开PR会触发默认CI并选中R4最大用例，不能在另一次本地最大之后再默认触发同一轮。

本轮明确批准的库名为 `app_test_r5_source_envelope_upgrade_ad4424`、`app_test_r5_source_envelope_upgrade_ad4424_w1`、`app_test_r5_source_envelope_regression_1a33fb`、`app_test_r5_source_envelope_regression_1a33fb_w1`。仅原入口建库／迁移／新worker重建及上述非空升级、正负例与恢复演练；旧18库不写，新旧库全部保留。升级一次全部通过且资源终态明确才执行普通R4一次；该次也全部通过且终态明确才创建同固定提交的Draft，由默认CI计原R4满额一次，不本地重复。任何失败或UNKNOWN立即停止后续阶段。

## 单次实际结果与最小修复（2026-10-20）

固定4947bb0c47ef3ff5dee2af9e66397d4dd035fa45执行升级一次，原始Jest退出1，1PASS/5FAIL。新模板148冷回放通过；首项非空147→148/no-op、历史checksum、196模型业务快照、其他函数/OID/ACL/约束/触发器/索引/设置保持均通过，12390ms。第二项57个完整UTF8 preimage/hash对照断言已通过，随后真实参数取样SQL误读 `AttendanceSettlementVersion.activityId`，报42703；该用例整体仍FAIL。后四项均被owned失败锁拒绝，业务验证NOT_RUN。普通R4、满额CI、推送与PR均NOT_RUN，未重启条件序列。

最小修复只让该取样SQL从Version经settlementRunId关联Run读取activityId；一条合法Version仍恰好一个输入，NULL/missing输入、全部断言、预算及121/148函数均不改。旧18库和本轮两新库保留；另外两个获批regression库未创建。退出收据显示目标客户端、自有进程组及观察错误均为空，PG观察器已退出，资源终态已知。原失败保留，修复后完整升级/正负例/恢复演练仍未验收；不得据此直接启动后续阶段。

## 回退与数据兼容

部署前若原子CREATE语句失败，不能算148成功；保留Prisma实际失败记录并调查。数据库事务回滚演练在新隔离worker内把函数体恢复为冻结121的原定义，核对完整stored roots、函数属性与目录，再主动抛错回滚演练；外层应仍为148、业务数据及迁移记录不变。它是恢复SQL和事务性质的证明，不冒充独立前向回退迁移已上线。

若以后确需回退已成功部署的148，另行审查新增前向迁移，内容仅 CREATE OR REPLACE 同一函数为冻结原体（原完整定义SHA `0ec20439da18fa1c544e2fe4db2e18d99c085e262b963723391b12bb72310f69`）；保留148已应用记录及全部业务事实，不修改历史、schema、约束、ACL或旧数据。因输入输出字节一致，无数据回填或旧指纹重算。当前没有新增149，避免自动部署把优化立即撤销。

本次未做：修复后重跑、四项失败闸后的业务验证、普通R4／原满额CI、旧18库写入、完整nightly、C1/S13、Ready／合并／发版／生产操作和真实数据转换均未执行。AC013/020/025延期TODO、AC017搁置TODO、31真实映射HOLD和现场10a/10b边界保持。
