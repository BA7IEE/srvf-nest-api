# E4 来源复用实施及验证记录

基线 `b7f5940434ba4b7084b998b4b86ae5b18af22ef2`；[Draft PR1380](https://github.com/BA7IEE/srvf-nest-api/pull/1380)。用户 `Sentinel_78d00b72fa5881918ba902157ccc9484` 已明确批准附件 `libfile_b2c74d8512d481918fb849db830afc91` 的47个精确路径整批实施、必要的精确代理grant、普通提交推送及GitHub独占临时PG16验证。授权不含最终SQL签字、trusted审批、合并、生产执行或放宽预算。

## 改动与等价目标

新增 `20261013000000_activity_contribution_assert_source_reuse`（143），仅替换 `public.e4_assert_complete(text,boolean)`。根聚合窄投影候选完整SQL SHA256：`c996a26fc7dca81e73a75843d9cdd792d895e5e66855899fd05a42ce7c02d819`；静态正文MD5：`ade4d2af9aa0baf8400a79fc6b62c797`。服务和精确pin回归同步更新，不接受旧新二选一，也不从live DB学习pin。旧1–142不改。

非unchanged_time分支内，来源合法性检查与expected全集比较共用同一SQL作用域的关系型MATERIALIZED来源，不构造JSON/数组缓存，不跨调用复用。expected构造复制140最新版，其余canonical快路保留。来源非法时CASE阻止expected/day构造。原错误优先级、SQLSTATE、constraint、消息与cast/溢出保持；FULL JOIN/IS DISTINCT FROM、排序、全文哈希、规模限制与全部前后检查保留。public来源/expected函数、所有触发器、OID/owner/ACL/default/security/search_path不改。

137固定前缀显式接受143后继；142历史测试固定deployUnitMigrations，不误跑当前143。30份CURRENT_MIGRATION_COUNT仅142→143。CI仅新增离线前缀回归一步，不改workflow权限、secret、环境、审查或合并门。

## 证据与验证状态

既有run38457728710业务prepare在诊断预算内39.656秒，事务39.361秒，COMMIT1/ROLLBACK0，完整oracle与正常清理。E4评价写入14.347秒（INSERT13.765秒）与屏障9.869秒不重叠，占事务61.5%。计划观测UNKNOWN/LOG/OUTPUT，不把观测失败说成业务失败；来源展开单独成本尚未测。

新增回归覆盖非空142→143、noop、全部业务行/目录/trigger/constraint/index/旧checksum保留，冻结独立根哈希/来源分母/跨日oracle，真实来源链→评价→根双错顺序、最终版本/result校验、真实INSERT后独立deferred失败与全事务回滚、观察到实际锁等待后的同语句快照及下一调用新可见性、143真实prepare/submit。

未解析来源与day构造双错用私有SQL函数副本及一个NULL来源字段/固定异常构造器测试；不改变公共函数或绕过前置数据库guard。它验证SQL控制流，不声称真实业务可持久化这种无效来源。完整现有并发与正式满额测试交由GitHub既有五分片；原2000 identities /10000 segments /50000 slices /8000 units和事务30秒标准保持。

当前轻检查：前缀10项PASS；首审服务72项PASS；完整类型检查与定向lint最终PASS；readtax/counts/codemap/authz/migcount检查PASS。47路径边界核验PASS，30个e2e仅计数变更，旧142份迁移字节及完整guard前后段保留。所有新SQL、迁移、e2e、正式满额GitHub结果为NOT_RUN，等待本次提交后的真实运行；无本地DB重测试。

## 2026-10-14 测试夹具恢复

`58ad2830` 的新143测试误从满额scale套件抽取了固定50000来源/10000分配预期，实际使用的是单身份小夹具，首个失败发生在143部署之前。此次仅修测试：从非scale settlement套件抽取固定根聚合、根oracle、完整oracle三个函数，保留全文来源SHA及内部canonical/root SQL SHA，不注册被读取套件的生命周期。日oracle另从固定 `E4_P_DAY_ORACLE_SQL` 提取并保持 `a8cdf667c0632e832d10ea2912ebd510e84163097ddfc594f55d000746446274`，显式验证单来源3600秒、跨日单来源5400秒与零人口的独立预期，包括1.00以及跨日0.33/0.67；不从候选/存储计数学习预期。

三个测试自有guard事务明确使用30秒timeout/5秒maxWait，防止默认5秒P2028遮蔽23514或刻意回滚；原SQLSTATE、constraint和整事务回滚断言保留。正式业务及scale文件不改。真实部署143后的日志另记录迁移数量、迁移名、checksum和body pin，不能将首个测试失败后残留142的后续结果算成143证据。

恢复轮本地已实跑：服务72项PASS，迁移前缀10项PASS，定向冷lint PASS；离线加载实际三个oracle函数及单评价替身比较PASS（不执行数据库，不代表SQL验收）。完整quick首次FAIL（lint=134堆内存耗尽，typecheck=1两处查询行类型缺失，unit=0、harness=0）。补齐行类型后完整typecheck复跑退出0；第二次全仓lint曾遇到并发自测探针清理的ENOENT，等待自测结束后以仅本地 `NODE_OPTIONS=--max-old-space-size=8192` 串行lint:cached退出0。复用未改动输入的449套/9971项单测、8快照以及guard/ESLint自测退出0，最终quick四项组件通过，不冒称首次quick全绿。counts/readtax/codemap/authz/migcount检查PASS。GitHub PG16数据库结果待本轮提交后的实际运行；143 SQL字节与正文pin在此次测试修复中保持原值。本轮三个路径不在红区，未发放不必要grant，工作树原无grant。

原run38474895287已终态FAIL。已取得的满额证据为prepare35115ms/267queries、E4_EVAL_WRITE12619ms、SET CONSTRAINTS8588ms及P2028（35002/30000）；独立连接落库计数全零，后续submit/review/ledger未执行。写入及屏障包括各自独立守卫，D4和E4成本须分开；这组总计时不能用于声称来源复用收益或143全项通过。历史失败保留，不重试旧交接中已被拒绝的日志下载路径。

`0054d125`/run38529368300 分片1的独立授权日志由父端提供：1 failed/86 passed suites、2 failed/1668 passed tests。小夹具来源预期误写2，实为1；D4桶的唯一键为timeRevision/identity/category（无日期），该单allocation/单slice只有一条sourceRef，5400秒和两个Beijing日分摊保持。此错误在专用升级测试第357行、`deployLatestMigrations()`第359行之前；job中07:36:42的全局143应用与无pending日志不能单独证明此专用baseline库已升级143。后续六个用例新增143安装前置核验：仅在本库迁移数量/名/checksum/body pin与候选字节都通过后继续，避免把残留142的结果标成143。

同一日志证明默认deferred COMMIT被`contribution evaluation set mismatch`拒绝，但Prisma6.19以UnknownRequestError封装，原P2010/meta断言不适用。修复保持原生COMMIT（不显式SET或改变触发器），在同一不完整根上用既有私有outcome函数取得真实23514/e4_evaluation_guard，再严格核对实际UnknownRequestError的PostgresError原生23514和精确消息。独立Prisma连接的完整业务快照先于错误断言执行，任何包装不符都不能遮蔽回滚检查。新增6个离线阳性/反例，拒绝普通Error、P2028、23505、其他guard消息及事务超时消息。本地6项PASS、定向lint PASS；7个数据库用例未在本云运行。全仓unit及Harness复用0054d125检查（src、配置、依赖与自测输入未变），受影响e2e类型/lint本轮重新检查。当前满额分片终态前不推送，不取消现有量测；143 SQL与正式30秒仍不改。

run38529368300现已终态FAIL：Fast checks、Harness、Incident replay、Golden journeys、Docker image build及E2E2/3/5 PASS；E2E1/4与Diff guards FAIL。父端从独立授权连接器取得分片4正式规模日志：prepare41437ms，P2028为41226/30000ms，E4_EVAL_WRITE24804ms，rollback11222ms，COMMIT0，独立失败后各数据表计数全0，submit/review/ledger未执行。这组写入及回滚时间不能相加充当无重叠阶段，也不能把与上一次运行的差额归因于SQL（143字节未变）。第二轮测试修复的完整typecheck、定向冷lint、全仓lint:cached及counts/codemap检查最终退出0；六项离线适配测试PASS。满额终态已核实，后续普通推送不取消该次运行。

## 根聚合标量投影单变量候选

测试修复先单独提交04627fe7。随后143 SQL只改一处投影：根聚合的MATERIALIZED documents由 `e.*` 缩窄为 `e."recognizedPoints"` 与原有unit/unit_key_json/source_fingerprint_json/evaluation_hash_json四个文本结果。`sourceRefsJson`、`beijingDayPointsJson`等整行字段不再携带进这一物化层，规范文本的计算、C排序、aggregate/hash、空集合和NULL语义不改；后续规模/日期来源检查仍从真实表独立读取。全文逆替换校验证明除这一标量投影外143字节不变，旧1–142无diff；静态候选SHA/body MD5见顶部。

服务只接受新正文MD5，首审单测额外拒绝上一个143 pin；专用143 checksum与安装前置核验、现有非scale精确pin测试同步新值。三个冻结oracle函数及其内部canonical/root/day SQL未改，仅被读取的非scale文件全文SHA因精确pin同步重算。权限、函数元数据、触发器、公开expected/source函数与全部守卫不改，不跨调用缓存，不复用一次INSERT的证明去放行deferred检查。

成本边界由现有代码确认：评价INSERT后的statement trigger调用 `e4_assert_complete(root_id,FALSE)`；根的deferred trigger再调用 `e4_assert_complete(NEW.id)`，两次完整校验独立。具名SET CONSTRAINTS屏障还处理D4的astr_parent_complete_guard，E4_EVAL_WRITE、屏障与rollback是不同观测范围，不能把屏障总耗时当成纯E4第二次守卫成本。当前只有总阶段证据，没有各SQL子段或D4/E4独占时长，窄投影收益尚未量测；正式规模和30秒通过条件不变。本云不执行SQL，等待新head GitHub PG16回归及正式满额。

按用户明确批准仅发放143 SQL精确路径grant，reason记录Sentinel批准原文及47路径附件；不授目录通配符，结束撤销该单项。最终SQL签字、trusted审批、合并部署仍不执行。

本候选实际轻检查：最终服务72项PASS（含拒绝旧143 pin），错误封装适配6项PASS、7项数据库用例本云SKIPPED；完整typecheck、最终全仓lint:cached退出0。authz检查曾按真实输入摘要判stale，给既有生成器的ROUTE_AUTHZ和assertion-patterns两个批准输出路径补精确grant后正常生成；ROUTE_AUTHZ只改两处inputDigest，patterns字节不变，663条授权声明不变，生成后authz退出0。readtax/codemap/counts通过。完整单测/Harness复用既有已通过且未受影响输入，首审服务72项单独复跑；SQL/数据库/e2e/正式满额仍须此最终head的GitHub实测。工作树核验全部变更均在47路径内；SQL逆替换证明只有一处投影变化，旧1–142和scale不变。本树原无grant，本次持有且仅持有上述3项，提交后核对撤销，不清他人授权。

## 收口边界

CUTOVER_SIGNOFF仍签历史136而实际目录143，不借用旧签字、不代填。trusted审批留给维护者，不代点批准。最终SQL签字、主干合并、生产迁移/部署、业务标准修改均本次未做。额外诊断、SQL_LENGTH5缺口与工作流扩建不在本批。结束核对并撤销仅本批4项grant，其他授权保留；GitHub失败如需清单外改动则报告精确阻塞。
