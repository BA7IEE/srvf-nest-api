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

## 2026-10-15 候选 C 正式接入（144）

用户已明确批准同一云端开发分支新增迁移、同步校验标识并执行隔离合成库小规模、500及仅一次满额 prepare→submit→first/final review→ledger。此次授权不含合并、部署、生产数据或人工签字。

144只替换 e4_source_rows 的 time_revision 来源 JOIN：内部仅 bucketId=b.id、窄列及 OFFSET 0；外层三相等、UNION ALL袋语义、allocation/slice/result和全部计算不变。规范化定义 SHA256 为 eaaae461562388412ea526e8ae5290a87786b2132e153f359338c2135a826a2e，与800f3f3d影子候选逐字一致；迁移 SHA256 为 ac47d7564ef20d3b5f82d9729d6e35ac04068729f2e73a288af6b606c726cb4e，source body MD5 为19d84ee9f25b81d33f0ffdef0a800ab5。历史1–143不改，143 checksum及complete body pin仍分别为c996a26f…/ade4d2af…。

真实入口独立选择ordinary-1、ordinary-500或maximum，保留原prepare30秒及后续预算、双guard与全局设置，无ANALYZE或90秒适配。父子报告绑定、成功/失败保留、原生INSERT缺项拒绝、deferred COMMIT回滚与独立失败七项计数均有对应验证路径。临时影子六负例/六优先级与原生guard测试分别记录，不混称相同覆盖。31处当前迁移计数同步144，旧143回归通过显式历史迁移入口保持143范围。

本地focused为130/130通过，完整test typecheck及定向lint退出0。首次本地E2E在模块收集期因Node搜索路径无法解析已安装的express而失败，127.791秒、0 tests、未创建目标库；只补本地NODE_PATH后重新执行收集，尚未有业务通过结论。真实路径结果在后续证据段记录；影子500通过不代替真实prepare或满额验收。

### 本轮实际结果与阻塞

本地三次启动分别停于：①缺少pnpm虚拟依赖目录的Node解析（127.791秒、0 tests）；②误带GitHub专用标记，被scope保护拒绝（43.800秒、0 tests）；③按本地W98入口运行后，在143 suite的beforeAll隔离迁移安装失败（45.623秒，21项离线通过、7项数据库前置失败）。144 suite被bail停止，prepare及500/maximum均NOT_RUN。未重跑已失败的业务序列。

第三次原错误仅为`E4 isolated migration deploy failed (details not echoed)`；包装丢失详细stderr，不能声称已取得原deploy的完整错误。无DB只读工具检查另复现`ENOENT: mkdir /home/agent/.local/share/pnpm`；把数据目录改到tmp后又被pnpm的无TTY模块重建保护拒绝，未允许删除或重建依赖。直接运行现有Prisma CLI可读出6.19.3。最小运行器修正是使用原workflow固定pnpm10.14.0的干净GitHub runner；已将143/144升级与原生guard回归接在真实ordinary-1全链之前，失败会阻断后续全链。

独立维护连接最终观测PG16、databases/clients/leaseBackends/leaseLocks=0/0/0/0；这是清理证据，不代表144业务回归通过。复用了原有PG容器，未移除共享容器。

正式git commit在自动审批审查中被拒绝，审查仍引用旧“只读、不得修改”范围，未采纳父任务附带的新确认（Sentinel_4dfee21d5ef48191a16b4d00cf5d5955）。按“再次拒绝则停止该动作”的指示，不再提交、推送或派发新run。当前HEAD仍800f3f3d，44文件改动仅在工作树，可审阅patch另存交接。下一步须先修复审批上下文，然后在新提交上按ordinary-1→ordinary-500→仅一次maximum执行，任何阶段失败即停止下游，不增加原预算、不重跑昂贵fixture求绿。

### 限量首发评估（只评估，未实施或部署）

本轮144真实路径未通过，不能给出新的生产安全人数。已有500档证据仅支持一个待验收形状：单活动、单session、一个北京时间日、500身份/500服务段及分配/2500切片/2000桶及bucketSource关联/2000评价单元/约2500条来源引用、500条结果；不能解释为任意500人活动。若未来真实500全链通过而满额仍失败，可把这组多维规模作为限量方案的最高待验收档，实际上线仍需下面的准入与验证。

服务端须单设E4准入，不能降低共享TIME_SETTLEMENT_LIMITS而改变既有D4。对身份、服务段、分配、切片、桶、bucketSource、sourceRefs、评价单元、Beijing日/跨日分摊及结果复杂度设明确上限；读取完整集合、锁后复核并在写入前以稳定业务错误拒绝超额。prepare、submit、重试及更正均不能靠分批绕限；更正按完整有效集合计算，尚未验证的跨日、多session、复杂更正及历史回填首发延期。已固定policy_v1的版本不能在超界或停用时暗退legacy。双guard、完整oracle、账目/幂等/权限/事务一致性/失败回滚与可恢复性不降级。

可先用的目标应是上述限定范围的新活动、新发布政策的正常prepare→submit→双审→ledger及只读证明；完整历史转换、广泛历史更正和更大/更复杂规模延期。E2全历史转换只有在维护者批准仅新活动/新政策口径后才可延期，既有legacy保持原真相；E3须确认首发活动是否涉及仍hold的映射/历史窗口，涉及者继续阻断，不把31类真实映射或未决窗口核销。

E5仍是实际可用的硬依赖：当前assertNativeWriteAllowed仅允许test+fixture，必须另行实现正式限量启用、独立服务端准入、版本制度边界和停用/恢复流程，不能把fixture用于生产。代码部署但保持off只交付关闭的代码，不代表用户能使用新积分，更不代表整个R5完成。必要上线证据仍包括当前候选的真实小规模/500全链及前后oracle、权限/幂等/并发与故障恢复、超额拒绝及锁后防绕限、准确部署SHA/迁移与回退演练、适用范围的E2/E3结论、维护者SQL/trusted/签字及既有D8-OPS/生产gate。当前不部署、不切换、不代签。

### 2026-10-15 审批恢复、锁定工具链与首轮数据库阻塞

父任务转达用户直接确认后，按原参数仅重试先前被拒绝的提交调用一次，自动审批已放行，44文件提交为 `789c9685eb9e4fe9416a76fec0b1f29a7527d11f`。先前拒绝仍作为历史记录保留，不移除或绕过审批。原44文件补丁134644字节、SHA256 `11c1e4e80c9a7c7d91d9dcb55d3a240f23be8ddd77a0ddbe077471ae95e948ed` 保持不变。

本地默认pnpm包装实际指向11.25.0，与packageManager/node_modules锁定的10.14.0不符。已在仓外工具目录下载10.14.0并验证npm元数据的SHA512完整性，命令局部PATH指向该版本，`pnpm --version`为10.14.0、`pnpm exec prisma --version`为6.19.3。没有重建或删除node_modules，没有修改依赖、锁文件、HOME或GitHub隔离标记。

迁移失败包装改为分别保留stdout/stderr原字节数、有界首尾、退出status/signal/错误code，先脱敏再截取；URL、已知连接凭据和敏感字段整行遮罩。JSON、Bearer及含空格密码反例、超长signal、两流与总大小都有离线测试，失败文件以0600权限写入且不覆盖原错误。workflow仅增加失败证据glob及对应离线测试，不改变权限或预算。最终四套聚焦单测190/190通过，完整test typecheck和定向lint均退出0；跨模型只读复核的两项脱敏/大小问题已修复闭合。

恢复后的唯一一次本地W98数据库运行使用真实本地入口、pnpm10.14.0及必要NODE_PATH，未伪造GitHub环境。实际结果为478.305秒，24通过/4超时，scratch lease最终清理另失败。首个失败是既有142→143非空升级测试的120000ms超时，另外三个测试各30000ms超时；原生deferred测试记录的是P2028（timeout30000/elapsed31134），不能计为23514回滚通过。143实际安装名/checksum/complete pin已在日志核实；144 suite因bail未执行，真实C全链、500、满额均NOT_RUN，满额尝试数仍0。独立600秒本地进程看门狗确认原进程自行退出，未发TERM。没有因失败而重跑夹具或扩大预算，也未派发GitHub运行。

失败后的独立观测先见W98数据库1、客户端0、lease backend/lock均0；随后通过原scratch lease能力重新取得同一锁，仅删除本次自有W98。独立PG16维护连接最终确认databases/clients/leaseBackends/leaseLocks=0/0/0/0；现有共享PG容器保留。这证明资源清理，不补作业务回滚或guard通过证据。日志和前后清理收据保存在云端交接包。

下一步的最小组织修正应先改workflow中真实C ordinary-1的前置命令：单独运行已有143→144非空升级/原生guard专用suite，不把完整142→143历史回归串在候选取证之前；旧143 suite继续由既有E2E CI必跑，失败仍阻断合并，不能被跳过或写成通过。候选专用suite失败则立即停止，不派发500或满额。若专用suite及真实small全链通过，才依次500及仅一次满额，沿用现有30秒及后续预算、完整冻结oracle和独立清理。此处只给出精确下一步，没有自行再运行。

另一个已暴露的组织缺口是Jest套件级bail不能取消已超时的异步数据库工作：本轮首个用例超时后仍有oracle/noop日志，现场也曾看到多条旧测试查询同时活动。不能把后续超时直接归因于候选SQL。若继续处理旧143测试，应让其数据库操作在原用例预算耗尽前可取消并完成cleanup，而非增加timeout或继续执行后续故障用例；所有原断言、SQLSTATE与双guard保持。55秒到94秒的既有波动原因仍未知，本轮日志不能解释那两次差异。

### 2026-10-15 候选专用前置与旧143必跑回归解耦

按父任务本轮明确指示应用原一行编排补丁：真实C ordinary-1前置只选 `activity-os-r5-e4-source-bucket-lateral-migration.e2e-spec.ts`。旧143 suite未删除、未skip、未修改；`test/jest-e2e.config.ts`的全量e2e匹配和`.github/workflows/ci.yml`第537行五分片仍会收集它，既有required聚合gate依赖slow且不接受非docs-only跳过。独立候选取证可继续，总体验收仍被旧143四个超时阻断。未改任何断言、超时、预算、SQL或正确性门禁，也未新建CI job或required context。

旧143这次失败的精确用例及证据如下。日志没有逐步时间戳，无法给出某个Jest超时瞬间的最后SQL；以下只记录实际可证事实，未观测处保留UNKNOWN。

| 旧用例（原文件test/e2e/activity-os-r5-e4-assert-source-reuse-migration.e2e-spec.ts）                                | Jest预算 | 最后已记录事实／缺口                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| preserves every business row and catalog identity on nonempty142 to143 and no-op with frozen root/day/source oracle | 120000ms | BASELINE_ORACLE相等、143安装pin正确、UPGRADE仅proargdefaults location差异；后续还输出CANDIDATE_ORACLE及NOOP相等，但NONEMPTY_UPGRADE完成收据缺失。哪些日志在120秒内完成为UNKNOWN，整项FAIL。 |
| keeps the independent final version/result check after valid sources and evaluations                                |  30000ms | 仅Jest超时，未设步骤收据；最后完成步骤UNKNOWN。事务原预算同为30000ms。                                                                                                                      |
| keeps INSERT and deferred checks independent and rolls back the whole transaction on a later incomplete root        |  30000ms | createMany处P2028，30000ms预算／31134ms已过；statementPassed=false、callbackReturned=false、独立业务snapshot相等=false。未到实际COMMIT，不算deferred拒绝或整事务回滚通过。                  |
| uses a real statement snapshot across an observed two-backend commit and reads fresh sources on the next invocation |  30000ms | E4_ASSERT143_SNAPSHOT完成收据缺失；最后完成步骤UNKNOWN。writer事务原预算20000ms，观察锁等待窗口5000ms，均不变。                                                                             |

这些失败保留为未解决项，暂不修改旧测试或重新量测。新候选按现有项目锁定工具链在GitHub独占合成PG16先执行144非空升级／原生guard／袋语义，然后真实small全链；各阶段通过才进入500及仅一次maximum。记录各run的HEAD、SQL pin、冻结oracle、完整链与独立清理；最大尝试在本轮开始仍为0。

### GitHub专用144首次结果与清理顺序修复

`7d63f002`／run38719292715的190离线测试通过；144专用套件4项业务测试全部通过：143→144非空升级与noop、完整目录/设置保持、10组来源袋和全文哈希相等、6个影子负例及6个优先级、原生INSERT缺项23514/e4_evaluation_guard且rowsAfter=0和独立快照相等、原生deferred COMMIT拒绝且statementPassed/callbackReturned/rolledBack/unknownRequest均true。

该suite仍整体FAIL（75.287秒）：afterAll报Scratch maintenance session ended。代码确认owner在同一describe中先注册DROP及lease release，而fixture close hook后注册，DROP先于Prisma/Nest关闭。最小修复仅把144 owner移至模块根：根beforeAll仍先安装，子suite afterAll先关连接，最后根afterAll执行既有DROP和lease释放；不修改scratch helper、断言或任何预算。workflow在专用suite后复用已有只读calibrationCleanupSql作独立四项清理观测，绑定HEAD/run并保存闭合收据；suite退出非零或清理未确认仍使步骤FAIL。旧143四超时不因此核销。

首次run的真实small全链未执行，500及满额未派发，满额仍0。GitHub最终移除临时容器成功；由于该轮未输出独立DB收据，数据库/lease清理单项仍UNKNOWN，不能借容器移除补称四零。新清理顺序将在下个小规模隔离run验证。

该清理修复的125项相关离线测试通过，新增6个真实workflow脚本VM边界案例单独复跑通过，完整test typecheck和最终定向lint均退出0。跨模型只读审查确认没有门禁弱化；项目安装的jest-circus执行代码也确认先递归子describe、后执行父afterAll。未在云端再跑PG夹具，实际清理与真实小全链交给下一次GitHub隔离运行。

### 2026-10-15 候选C真实队列最终实测（同一代码HEAD）

验证代码HEAD为 `e589b2d0148d345d5bcc2e7f37c3da11c7092a9f`。清理修复后依次执行small、500、唯一一次maximum，全部为attempt1、GitHub独占PG16、锁定pnpm10.14.0和Node22.23.3。每轮196项聚焦离线测试通过；只在前一场景的完整闭合报告验证通过后才派发下一场景。最大派发/执行次数为1，不再重试。三个场景均验证144/143 checksum、C source pin、complete pin和独立INSERT/deferred guard目录，manualAnalyze=false、实际prepare预算30000ms、90秒适配调用0。

| 场景         | run                                                                             | source build（秒） | prepare（秒） | 后续链与冻结oracle                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------- | -----------------: | ------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| ordinary-1   | [38720653421](https://github.com/BA7IEE/srvf-nest-api/actions/runs/38720653421) |              0.776 |         3.508 | submit6.708、first review1.544、final review3.099、ledger7.853；五阶段及每阶段冻结oracle完成，1条ledger credit，总额匹配冻结root。    |
| ordinary-500 | [38721184446](https://github.com/BA7IEE/srvf-nest-api/actions/runs/38721184446) |              2.560 |         8.630 | submit8.764、first review2.072、final review4.142、ledger11.563；五阶段及每阶段冻结oracle完成，500条ledger credit，总额匹配冻结root。 |
| maximum      | [38721554302](https://github.com/BA7IEE/srvf-nest-api/actions/runs/38721554302) |             35.958 |        35.708 | PREPARE/P2028；错误记录timeout30000ms、elapsed35601ms。后续oracle、submit、双审、ledger均NOT_RUN。                                    |

source build与prepare是不同阶段，不能相加作为事务耗时。small的144专用4个数据库测试全部通过，10组袋/哈希、6个影子负例、6个影子优先级与两个真实原生guard测试各自留存；专用suite结束后、真实全链结束后两次独立清理均四零。500实际形状为500身份/500服务段及分配/2500切片/2000单元与桶及bucketSource关联；prepare后的独立事实为roots1/evaluations2000/timeRoots1/buckets2000/sources2000/receipts1/audits1。small/500各281条prepare查询，评价INSERT1、屏障1。它们证明本候选真实路径通过，不能代替所有业务场景或完整R5验收。

满额已通过真实合成来源的2000身份/10000服务段与分配/50000切片/8000单元形状检查。事务观测为30000ms预算、35705.795ms事务wall、terminal=rollback/outcome=ERROR；native事件COMMIT0、ROLLBACK1（query event duration5599ms）。失败后在正常DROP之前，独立只读连接观测roots/evaluations/timeRoots/buckets/sources/receipts/audits七项全部0，状态OBSERVED_SEVEN_ZERO。该七零与最后DROP之后的清理四零分别记录，不混为一种证明。

满额失败方法阶段是E4_EVAL_WRITE，wall21618.941ms；E4_EVAL已返回，E4_PREPARE整体25412.553ms为包含该方法的嵌套范围，不能相加。选定native请求进入时钟14365.324ms、返回时钟35604.197ms，随后外层报错。native覆盖状态UNKNOWN、原因SQL_LENGTH、5个query事件未覆盖；EVAL_INSERT计数0及屏障0不能据此认定INSERT从未执行，不能声称C纯SQL/guard完整成本已取得。ROLLBACK query event包含的等待/回滚也不能直接加到E4_EVAL_WRITE wall上。35.708秒与历史55/94秒不构成受控单变量比较，收益归因及既有波动原因仍未知。

三个实际run的父报告均独立观测PG16且databases/clients/leaseBackends/leaseLocks=0/0/0/0，resources=CLOSED，GitHub容器移除步骤成功；满额失败完整闭合报告、原生事务时钟、七零和清理收据均已保留，未丢失为只有泛化stderr。交接目录为云端 `/workspace/e4-c-real-github-e589b2d0/`，包含每run元数据、脱敏/私有日志、闭合JSON、队列门禁收据和hash清单。报告保留DIAGNOSTIC_ONLY/NOT_AN_ACCEPTANCE_RESULT，accepted=true仅表示下一场景的队列条件满足。

旧143的四个超时仍为FAIL/hold，名称、原预算和未知步骤见上表；旧套件仍在常规必跑E2E与required聚合门禁中。本轮不修订它的断言或预算，不把候选取证成功当成旧回归通过。最终SQL签字、trusted审批、完整必跑CI和生产门禁均未代办。

限量评估现在具备本候选500形状完整链的正面证据，但满额30秒仍FAIL，仍无上线许可。最多只能将已验证的单活动/单session/单北京时间日、500身份/500段及分配/2500切片/2000单元及桶/2000bucketSource关联/约2500sourceRefs/500结果作为待正式验收的多维上限，不扩展成任意500人活动或未经验证的更正/跨日/多session。独立E4服务端准入、锁后重验和稳定拒绝、E5正式限量启用模式及停用/恢复、适用E2/E3与D8-OPS/人工审批仍待完成；当前服务仍仅test+fixture可写，不能用fixture上线。共享D4/TIME_SETTLEMENT_LIMITS、预算和双guard均不降低，代码关闭态部署也不代表业务已可用。

### 2026-10-15 145精确key携带实施与有限验证队列

用户本轮明确批准在同一开发分支新增145、先等价与负例/回滚、再small及一次500真实全链、提交推送现有Draft PR；禁止自动再次满额。145 `20261015010000_activity_contribution_evaluation_join_key` 仅替换complete函数：expected_documents携带metadata内evaluationUnitKey、expected直接用该列，全文JSON/FULL JOIN/root/错误优先级及双guard不变。143/144 SQL不改，144来源pin继续19d84ee9f25b81d33f0ffdef0a800ab5，complete新pin为b03a7298e625b703fa2f011c0fbcc6c0。145文件SHA256为821e176badcd6a0264a4e45535a9d226dc8a09525db56299561527d56316166d。

写集为新145 migration、service及其pin单测、迁移前缀/fixture、31处CURRENT_MIGRATION_COUNT、144历史套件的显式144 deploy入口、新145专用数据库/离线测试、既有诊断driver/workflow和必要生成摘要/当前状态记录；不改schema、seed、权限、API、预算或正式准入。历史144测试保持目标144，新145测试从合法非空144升级，比较完整业务数据、其他catalog、设置及noop，并分别证明影子六负例/六错误优先级与原生INSERT/deferred回滚。跨模型复核和本轮数据库结果仍待下文实测，不能预写PASS。

真实145路径仅允许ordinary-1与ordinary-500，以独立flag绑定新pin与收据，不重标旧144证据。规范化对照在完整业务链后复用同一合法夹具，比较当前C helper上的两个完整函数体；同后端、同局部force_custom_plan/原work_mem/JIT，500预期两轮各2000规范化聚合降为一轮2000。对照不计入prepare，双guard未替换或跳过；完整oracle、账本总额和独立清理仍须通过。正确性、pin、优先级、回滚、原预算或预期机制任一失败即停下游，不创建新满额尝试。

旧143四项回归的最小修复已进一步收敛。日志先输出后续deferred用例COMMIT_ERROR，再输出首个升级用例CANDIDATE_ORACLE/NOOP；结合已安装jest-circus仅reject超时Promise，证明超时异步体继续运行并相互重叠。upgraded143在最终非空升级证明结束前已置true，后续前置检查不足以阻止干扰；owner在同describe内先注册DROP/release、后注册fixture关闭，是另一个确定缺陷。全表rolledBack=false在这种重叠下不能证明原子性破坏。

四项精确原因/判据：①120秒升级首次超时的最慢SQL仍UNKNOWN（日志无阶段时间）；应保留所有比较点，给快照/各root oracle/deploy/最终比较加安全阶段耗时，完整结束才开放依赖。businessSnapshot逐表串行全量读取至少196表，可在保持每表完整规范化行、顺序、集合及每个比较点的条件下合并往返，不能抽样或仅计数。②version/result的30秒最后步骤UNKNOWN；消除重叠后保留两次validate_version=false成功及两次23514/e4_result_guard精确断言和回滚。③原生deferred用例已证在createMany收P2028（30000/31134），statementPassed及callbackReturned均false，尚未进入COMMIT拒绝证明；先隔离，再以原预算证明INSERT成功、回调返回、真实COMMIT拒绝和独立快照相等。④双backend30秒最后步骤UNKNOWN；保留writer20秒、锁观察5秒、总30秒，记录writer就绪/锁等待/提交/最终oracle并在失败时释放gate、等待双方结束。

旧143最小组织修复应保留离线describe在外，将DB owner放外层DB describe、fixture置内层，使客户端先关闭再DROP/release；还须让预算到期时取消并等待本用例所有查询/事务结束，不能只移动owner或继续下一用例。四项仍FAIL/hold，常规required CI继续必跑，候选入口拆分不核销任何旧失败。

145提交前结果：改动前service72项通过，最终六套聚焦277项全部通过；src/test/scripts三段完整typecheck退出0，定向lint在修复throw类型后退出0。authz当前663条，仅生成输入摘要变化；counts145、31处迁移计数、readtax通过，CODEMAP同步迁移/E2E计数。跨模型复核闭合draft取证根、verbose实际计划前缀、主错误与清理错误分离、145报告身份及64KiB边界。误启动的常规全量单测已主动终止（143），未计为通过；本轮仅采用聚焦测试。尚未运行业务数据库或GitHub队列，下一步为独立PG16临时能力检查、非空144→145及原生guard四项、small全链，再由同HEAD成功收据放行唯一一次500。

### 2026-10-15 145真实small/500及同夹具规范化取证完成

代码HEAD `32343421f6fbb68125464a4a08ef007b2a3b1d6c`，同一分支Draft PR1380；45文件提交包含145及必要配套，143/144历史SQL SHA均保持。small和500都是attempt1、独占合成PG16、原30秒prepare与原后续预算、无手工ANALYZE。最后两处诊断能力guard的完整test typecheck与driver lint复查均退出0。

| 145场景 | run | prepare | 结果 |
| --- | --- | ---: | --- |
| small | [38729058358](https://github.com/BA7IEE/srvf-nest-api/actions/runs/38729058358) | 3.332秒 | 专用非空144→145/noop、业务/其他catalog/设置保持、六影子负例/六影子优先级及真实INSERT/deferred回滚四项通过；真实五阶段、每阶段冻结oracle、1条credit及总额通过。 |
| 500 | [38729748256](https://github.com/BA7IEE/srvf-nest-api/actions/runs/38729748256) | 6.219秒 | 500身份/500段及分配/2500切片/2000单元及桶形状、五阶段与冻结oracle通过；500条credit、总额匹配root。 |

以下为跨runner阶段观测对照，不把全部差额归因于key携带，不推算满额或百分位：

| 阶段 | C原代码e589b2d0 small | 145 small | C原代码e589b2d0 500 | 145 500 |
| --- | ---: | ---: | ---: | ---: |
| PREPARE | 3.508秒 | 3.332秒 | 8.630秒 | 6.219秒 |
| SUBMIT | 6.708秒 | 6.190秒 | 8.764秒 | 7.964秒 |
| FIRST_REVIEW | 1.544秒 | 1.429秒 | 2.072秒 | 1.675秒 |
| FINAL_REVIEW | 3.099秒 | 2.788秒 | 4.142秒 | 2.439秒 |
| LEDGER | 7.853秒 | 7.093秒 | 11.563秒 | 6.925秒 |

500 prepare内部阶段对照（wall，不能把E4_PREPARE与其内层EVAL/WRITE相加）：

| 阶段 | e589b2d0 | 145 |
| --- | ---: | ---: |
| C3_PROOF | 0.041秒 | 0.050秒 |
| C3_SOURCE | 0.189秒 | 0.183秒 |
| C3_EVAL | 0.126秒 | 0.097秒 |
| C3_BUCKET_WRITE | 0.327秒 | 0.261秒 |
| E4_PREPARE | 4.292秒 | 3.086秒 |
| E4_EVAL | 0.414秒 | 0.309秒 |
| E4_EVAL_WRITE | 3.844秒 | 2.746秒 |
| C3_RECEIPT | 0.345秒 | 0.249秒 |

500同一合法完整链的draft在业务链完成后被复用，当前public C来源helper、同一psql后端、work_mem4096KiB/JIT on/事务局部force_custom_plan。旧/新两个临时完整函数体均保留完整JSON/FULL JOIN/root，standalone调用validate_version=false；最终版本状态与两个native guard由真实全链/专用数据库测试分别证明，不能混称standalone覆盖。ABBA基线1912.945/1730.826ms，候选1455.626/1453.114ms（单组均值约低20.2%，无百分位/独占因果承诺，未单独保留统计不变收据）。

两份严格匹配完整共享guard语句、全2500来源/2000groups/2000pairs的实际计划中：基线document canonical Aggregate节点39、44各loops2000，候选仅节点39 loops2000；同样19字段jsonb_each，documents规范化聚合调用4000→2000，确实观测到预期机制。instrumented statement为1688.428/1336.047ms，节点均值为每loop inclusive，不求和。该取证不计入prepare，也不能从原生INSERT耗时扣除它来推算纯写入成本。145的原生INSERT query event为2703ms，e589为3781ms，同样只作跨run观测。

small专用suite结束及真实全链结束均独立清理四零；500对照owned backend确认消失，最终databases/clients/leaseBackends/leaseLocks四零、resources=CLOSED，两个job的临时PG容器移除均成功。结果标签仍DIAGNOSTIC_ONLY/NOT_AN_ACCEPTANCE_RESULT，accepted=true只表示有限队列放行。闭合报告、两份精简完整计划、原始私有job log和逐阶段对照留在云端证据包。仅执行small及一次500，原满额nonce与唯一run38721554302保持，没有再派发满额。

此结果解除145的小规模/已测500形状候选取证阻塞；未解除旧C满额30秒FAIL或证明145满额。旧143四项FAIL及逐项最小修复仍按上节保留，常规required CI继续hold；E4多维准入/真实规则与字节边界、E5正式模式/停用恢复、适用E2/E3、SQL/trusted/人工签字及D8-OPS/生产Gate均未代办。未部署、合并或将fixture用于生产。

终版跨模型只读复算核对两份报告绑定、完整五阶段、账本、预算、独立清理及500计划节点，未发现与结论冲突；两份闭合报告17144/27650字节，均低于64KiB上限。该复核不替代完整required CI或人工批准。


### 2026-10-15 旧143设施收束与off准备回执兼容续作

本轮基于644482cf，未追加500、满额或GitHub诊断运行。旧143的全部原业务断言、比较点及30秒／120秒预算保留；源码token核对覆盖16个静态具名旧用例。完整业务快照保留相同public普通表集合（至少196张）、每表完整JSONB规范化、行序和重复行，仅将每次至少197次往返合为2次；新增空表／重复行／引号标识符及同计数内容变化的PG等价用例。DB owner外层、fixture内层，正常路径先关闭客户端再DROP；143升级完成标记移到完整oracle、catalog、业务数据及noop证明末端。

每个DB用例及整个内部初始化钩子由同一owner收束，在原预算内预留3秒；任何失败均按当前库及本次随机application_name取消自己持有的后端，取消和工作结束各限1秒，UNKNOWN持续阻断后续用例及DDL。专用143迁移使用真正await的独立进程组及剩余预算，后代闭合未知禁止DROP／restore；不会驱逐其他worker连接或使用FORCE。基线owner的完整setupPending也接到finalizer。 随后将取消能力从昂贵业务前置独立验证：原具名租约持有的空W98库、不执行迁移或业务fixture，真实Prisma后端的慢查询被精确PID／当前库／随机application_name取消，原5秒probe预算内返回P2010、pending=0、独立monitor可用，最终独立四零。此为取消设施验证，不冒充143业务回归。外层同步git show及租约DROP／CREATE仍不具备相同主动取消，不能称整个外层setup均可在117秒内取消；其未闭合状态只能阻断finalizer。新增阶段收据只含阶段与耗时，不含业务行或SQL参数。

实际仅启动一次旧143小suite：173.151秒退出1，21项离线通过；内部beforeAll超过原120秒，9项DB用例均未进入，含原四项回归，不能关闭旧失败，也不能把新增PG取消／快照等价记为实测通过。初始化的最后SQL及耗时主因仍UNKNOWN。此失败揭示初始化也必须纳入owner，后续已补整体初始化收束及阶段收据，但本轮未重复夹具验证最新补丁。原进程退出后经原具名租约独立回收，最终再次独立读取databases／clients／leaseBackends／leaseLocks均为0，既有PG容器保留。 另用单一psql会话、三个TEMP表和实际同一snapshot helper完成轻量PG等价验证：空表、重复行、引号标识符、同计数内容变化均通过，ROLLBACK后TEMP表消失、会话关闭；未建立新的业务夹具。

E5只修复已经冻结的off兼容不变量：ensurePrepareJob对已有job保留batch锁、preparing状态及独立v1.1／maintenance闸，只读重验原source和manifest再返回旧回执；缺失manifest拒绝，不补建；新job仍先过原native写闸再创建。只读入口复用原source及逐字段manifest验证，不要求未完成job已生成完整entries。改编排前48项characterization通过；最终4套定向70项通过，包含11项取消／进程组离线用例，且两个helper已精确纳入常规unit收集。

新增隔离单人DB用例通过（suite总142.011秒，含编译／安装／fixture，不作为业务性能值）：真实prepare→submit→双审建batch，独立off配置实例拒绝无job的新写，fixture合法建立原job后off返回同一未完成回执，两个比较点均核对全部业务行不变；job仍pending且succeeded=0、manifest=1、entries=0。最终独立四零。该结果仅证明准备任务回执路径，不能替代所有HTTP／审核／更正off兼容验收。

正式active仍未实现；冻结原文只给方向与兼容不变量，没有给全套活动／新run资格、多维限量及字节／政策复杂度阈值、旧规则只读范围和恢复off后旧规则写入策略。不能自行补制度。生产窗口、映射／差异批准、SQL／trusted／人工签字、D8-OPS及开关仍为独立硬门。本轮未改143／144／145 SQL、pin、生产预算或双guard，未运行新满额、部署、合并或代签。

最终完整src类型检查及本轮12文件闭包定向类型检查退出0，目标lint退出0。完整test类型检查曾启动后主动终止（143），不计为通过；定向70项单测与最终21项离线回归通过，9项DB仍未重新进入。常规required CI继续hold。

### 2026-10-15 旧143进程收尾误判与单来源定位

E5局部修复已提交1796f90，后续文档校准9fa363e；继续处理旧143，不追加满额矩阵。首次独立单来源诊断在业务前置失败：Prisma状态0且136条迁移全部成功，但进程组检查被分类为UNKNOWN，finalizer正确拒绝DROP。独立观测为库1、连接／租约backend／租约锁均0，随后经原具名租约正常DROP并独立确认四零，未使用FORCE。

不连接PG的真实Jest进程复现确认原生ESRCH来自另一Error realm，`instanceof Error`为false；修前11例恰有跨realm ESRCH及真实pnpm调用两例失败，其余9例通过。最小修复只将两处ESRCH改为结构化code判断；EPERM、缺失／非字符串code、后代残留、未close、超时及非零退出继续失败。最终两个helper共17例通过，包含有界真实CLI；没有额外裸子进程。单来源诊断与应用闭包定向类型检查、最终helper类型检查退出0，最后真实CLI取证收尾修订的定向lint也退出0；完整常规CI未据此核销。

修复后仅运行一次合法单来源142诊断，1项通过。原120秒封套内实际103364ms：142部署5583ms、应用夹具13283ms、来源3442ms、prepare15779ms、submit33901ms、冻结oracle30759ms；suite总182406ms还含加载及外层基线安装，不能作为业务耗时。这证明已越过进程管理阻断，并表明该次主要成本在历史142的prepare／submit及oracle，尚不能归因为某条SQL或JIT。冻结oracle文件SHA和142 pin均核对，真实来源与完整两个roots保持；该诊断明确acceptance=false，不能代替原三活动／六roots及四项旧143回归。结束后独立确认PG16及资源四零，既有容器保留。原四项仍HOLD，下一步须先取得具体执行成本证据；不盲目重跑整套夹具或增加预算。

### 2026-10-15 历史143专用连接修复：JIT固定成本取证

一次明确受控实验复用同一份合法单来源142夹具：真实prepare／submit后，原冻结oracle完整两个roots通过，再在同一后端／同一draft root的只读事务执行ON／OFF／OFF／ON四次原生`e4_assert_complete(root,FALSE)`。带auto_explain ANALYZE／TIMING的墙钟分别4622.722／103.633／101.396／3709.542ms；它们不等于默认TRUE校验或完整prepare耗时。100ms日志门槛会漏掉更快的OFF计划，不能解释为OFF未执行。

两次ON的内部EXPECTED_BUILD估算cost均1603558301.13、实际返回1行，77个JIT函数编译分别4042.297／3531.908ms，占该内部语句4128.649／3608.935ms的约97.9%。因此本次历史142同root校验的高固定成本可以明确归因为该语句的JIT编译主导；内外层耗时包含，不能相加，也不能把全部历史超时或当前145表现归因于此。PG按估算成本决定JIT及高成本优化，机制见[PG16文档](https://www.postgresql.org/docs/16/jit-decision.html)。没有改变plan_cache_mode；探针实读auto，prepare自身仍按原实现事务局部force_custom_plan。

JIT-off夹具的prepare1899.692ms、submit4790.590ms、冻结oracle320.047ms，整个诊断含ABBA为39095.293ms，suite总77050ms；这些是另一轮夹具的阶段观测，不作为生产收益或p95。实验1项通过，8条目标PID嵌套计划完整解析并经跨模型逐项核对；LOCAL GUC在同PID恢复，独立默认连接始终on，最终独立四零。此前空库轻量验证还确认URL启动选项覆盖两个不同池连接，无迁移或业务夹具，结束四零。完整受控源码／补丁及私有原始计划保存在云端`/workspace/e4-143-followup-9fa363e/`，没有将这套一次性控制代码并入诊断入口。

最小实施只改原143 spec：默认monitor先连接，再给本spec的业务／迁移CLI URL追加`options=-c jit=off`；fixture、每个case、取消probe和两个observer检查实际off，teardown独立核对默认值未变后按原错误汇总继续关闭连接。未更改全局、数据库或角色JIT配置。原88个直接断言、全部SQL模板、三活动／六roots、30秒／120秒预算及双guard逐项保留。默认JIT的历史性能继续HOLD；修复后的历史正确性整组尚待下文实际验证，不能预写通过。用户已明确继续开发测试；先前“本轮不再开库”是代理对单次实验收口的自行安排，并非授权禁令。

独立治理阻塞仍分列：常规CI的Cutover sign-off ledger gate失败，仓内只读重验同为exit1，3b签字记录migration-total136而现读145，需要维护者重签；AI不改数补签。Trusted历史503按父会话证据单列为平台错误，本轮7bbcaaee的trusted scan已通过、approval仍waiting，未代批或重跑；历史日志下载不可用，未独立复核503正文。它们均不由本次JIT正确性修复代替，SQL／trusted／人工签字及生产Gate仍保留。

最小补丁提交前：原21项离线通过、9项DB未选择；新增连接检查和case包装函数的原样抽取闭包类型检查退出0，非完整test类型检查。首次定向lint仅11处新增代码格式错误，修正后最终原文件定向lint退出0、格式检查通过；全文件静态核对原88个expect调用及全部原SQL模板保留、全部case和setup预算不变。未运行全量单测或新增满额；下一步在该实际提交上执行一次原整组，不把离线或单来源结果代替原回归。

### 2026-10-15 原143整组实际收口（显式历史正确性配置）

实际代码HEAD `7bbcaaee2e705d704771c4ad5b14347c7942c9c6`，原spec SHA256 `7dedb2d846898a2ae6574badd9941a506ce4165eedc7df9911791d0d250704b3`；提交／推送后在云端本地W98独占租约执行一次原文件，无testName筛选、无伪造GitHub标记、无并发类型检查或lint。结果**30通过／0失败／0跳过**，包括21离线及9数据库用例；suite154480ms含加载、基线安装、全部测试及关闭，不是业务性能值。三活动／六roots初始化56147.672ms，在原120秒内完成。

| 原四项阻塞 | 原预算ms | 实际ms | 原断言结果 |
| --- | ---: | ---: | --- |
| 非空142→143及noop、完整业务／catalog／冻结root/day/source oracle | 120000 | 41733 | PASS，6 roots、142历史checksum、完整业务及catalog保持、noop均完成 |
| 独立最终version/result检查 | 30000 | 866 | PASS，四次原old/new错误优先级及回滚检查完成 |
| INSERT与deferred独立、后续缺项导致整事务回滚 | 30000 | 1567 | PASS，statementPassed/callbackReturned/rolledBack均true，原23514 guard及严格COMMIT包装验证完成 |
| 双后端真实statement snapshot与后续新鲜读取 | 30000 | 1541 | PASS，实际观察锁等待、statement前后0／0、下一调用可见及提交均完成 |

新增真实取消、全文snapshot等价、错误优先级、私有双故障及143后真实prepare／submit用例也全部通过。PROFILE收据确认业务jit=off、独立默认on，关闭前默认保持；原正常客户端关闭→DROP→租约释放后，独立PG16观测databases／clients／leaseBackends／leaseLocks全部0，既有容器保留，未使用FORCE。这解除本次显式JIT-off配置下旧143的正确性阻塞；历史默认JIT性能记录及旧C满额FAIL均不核销；当时145专用满额尚未派发，后续常规CI最大例的失败见下文。常规required CI、3b签字136→145、Trusted及正式启用／生产条件仍独立保留。


### 2026-10-15 继续Release 5：确认缺口与实现缺口分开

719e16a8的实际required CI快照：Diff guards仅Cutover sign-off ledger gate失败，其余该job步骤通过；Trusted scan通过、approval等待，Fast checks及五个E2E分片当时尚在执行，不能称全绿或代码失败。7bbcaaee部分工作被后续提交自动取消，聚合required失败不等于新增TypeScript/E2E失败；本轮未手动cancel/rerun。历史503按既有证据保留，不挪用为当前失败原因。

**最小需维护者决定的三项：**

1. **3b审查确认**：最后有效签字为第136条，而不是137–145已签仅漏改计数。须确认下表九份实际SQL均已按逐刀变更审查，覆盖137新增不可变根／评价、同链锚和完整性守卫，138–142完整canonical等价快路径，143来源复用、144来源JOIN与145 key携带；核对变更没有改旧1–136字节、放宽完整JSON／FULL JOIN／root／双guard／预算或引入真实数据DML。附当前准确SHA和验证结果，明确145 small/500通过、原143仅JIT-off正确性通过、145专用满额未派发、常规CI最大例prepare29.271秒后整例600秒失败及required CI未绿。维护者审查后明确确认“第137–145条上述完整摘要的3b重签”，才可登记新日期／依据及migration-total145；此确认不代替尚缺测试，不代表生产或Gate批准。AI本轮不改CUTOVER_SIGNOFF。

| 序号 | 实际migration目录 | SQL SHA256 |
| --- | --- | --- |
| 137 | `20261003000000_activity_contribution_settlement` | `90f09f61ef65753a00b885cd960e9f85ee8d9ed9ff39f2c55c2f7d5942fb0e61` |
| 138 | `20261012000000_activity_canonical_json_scalar_fast_path` | `f6f0718c6043ee4dc739276db2a90700bfcce159a1666f202e48ee639ffe2f5f` |
| 139 | `20261012010000_activity_contribution_reference_canonical_fast_path` | `8f6fee0ae5e7d29e4da15d0f79e1dfc275ec3efc87931b2fd67b1e5b935c6652` |
| 140 | `20261012020000_activity_contribution_evaluation_canonical_fast_path` | `5d7ff28a64a638440aaa1e9a798a2602f933fc9d6f8b23b68355199dad143513` |
| 141 | `20261012030000_activity_time_bucket_canonical_fast_path` | `d10d495eb1e2bc9447f491fb7960eba0c58b8bfb3ab990803e57f676431658a4` |
| 142 | `20261012040000_activity_canonical_json_unit_fast_path` | `bfac074c91474783f7b91f73b44e8ff431facef3f8139d1535a06c0fe45e6fa7` |
| 143 | `20261013000000_activity_contribution_assert_source_reuse` | `c996a26fc7dca81e73a75843d9cdd792d895e5e66855899fd05a42ce7c02d819` |
| 144 | `20261015000000_activity_contribution_source_bucket_lateral` | `ac47d7564ef20d3b5f82d9729d6e35ac04068729f2e73a288af6b606c726cb4e` |
| 145 | `20261015010000_activity_contribution_evaluation_join_key` | `821e176badcd6a0264a4e45535a9d226dc8a09525db56299561527d56316166d` |

2. **下一次145满额的范围和一次执行授权**：推荐只验证原业务service全链的一次隔离样本（不代表受限生产数据库执行面已验证），精确新HEAD／run_attempt1与新的145专用一次收据（不重用旧C已消费额度）、官方PG16隔离scope、原2000身份／10000段及分配／50000切片／8000单元及桶／40000bucketSource来源关联，prepare→submit→一审→终审→ledger，每阶段完整冻结maximum oracle和实际credit合计；保持原prepare30000ms、后续原预算、双guard、业务连接默认JIT与原事务local plan配置（不套用143的JIT-off正确性配置，oracle仍沿原只读设置），不手工ANALYZE、不附加ABBA／影子变体或扩大探针，不把单次通过写成p95／容量承诺。开跑前核实SQL143–145、source／complete pin、冻结oracle摘要、独占租约及空目标。身份／摘要／范围／预算校准失败在夹具前停止；任一阶段超时、原生错误、oracle不等、回执缺失或资源状态UNKNOWN即停止下游，保留主错误／完成阶段与独立清理，不换key或重建fixture求绿；仍用原560秒TERM／590秒KILL／600秒硬截止监督和具名正常close→DROP→release，禁止FORCE。旧C唯一满额失败不核销。

   **这不只是缺确认，入口代码也未完成**：`requireDiagnosticEnvironment`主动拒绝key145+maximum，且`realKeyCarryProbeSql`／`realKeyCarryPlans`仅支持4／2000单元，后置计划／普通oracle不能拿来冒充8000单元。最小候选写集是现有`.github/workflows/activity-os-r5-e4-validation.yml`、`test/diagnostics/e4-prepare-cost.diagnostic-spec.ts`、`test/helpers/e4-evaluation-join-key-migration.spec.ts`及本评审稿：新建显式、默认关闭、独立一次范围；保留原small/500拒绝max测试，为新范围加精确HEAD／原预算／8000形状／失败停止／报告64KiB负例，并把满额完整业务oracle与small/500后置性能比较分开。workflow精确grant和一次执行须另行确认，本轮不修改这些入口或消费满额标记。

3. **E5正式制度合同**：E4§3.1明确只允许off/fixture，active“必须另行评审扩展及生产授权”；T0只定义正式切换／旧规则只读及“差异归零或有批准清单”的退出条件。维护者至少需确定：首发是否仅新活动／新run／新发布政策且延期历史转换与复杂更正；精确多维及政策／字节复杂度上限与稳定拒绝语义；旧ContributionRule只读作用范围及既有legacy业务如何继续；off后的待处理native任务／更正如何恢复、谁执行与怎样验证。500实测形状只能作为候选上限，不能自动变为任意500人的业务许可。正式active、锁后全量准入、防分批绕限、旧规则写者约束和恢复流程均是**尚未完成的代码与验证**，确认合同后仍须精确写集、红区及隔离正反例实施；不是补一个环境变量或单纯缺签字。

可独立推进部分：跨模型按draft→prepare→submit→review→ledger／历史读面追踪，尚未发现可确定的冻结off合同生产代码违例；不为凑进度新增active。原审核26项characterization先通过，新增真实off配置下首／终审×approve／return的合法原生回执、新原生写入拒绝和legacy继续原路径，并补失配回执及v11／maintenance门，保留原全部断言；这些是模拟DB协作者的定向单测，不是正式active或完整HTTP／DB恢复验收。已有真实off准备回执隔离证据保持，不扩大其覆盖范围。

本轮最终定向结果：四套367/367（配置222、贡献service72、ledger准备29、审核44），审核为原26加新增18，不与中间批次361重复计数。目标文件及导入闭包类型检查1031源码／0诊断、定向lint退出0；静态核对原60个expect全部保留，跨模型移除新增块／fixture扩展后确认旧spec逐字一致。readtax、CODEMAP与counts检查通过；这不是全仓新一轮DB／HTTP或active验收。


### 2026-10-15 required CI终态与可确定夹具修复

719e16a8的常规CI `38749797740` 现已终态：Fast checks／Harness／Golden／Incident／E2E2、3、5通过；E2E1为5失败／1688通过，E2E4为25失败／2096通过／4跳过，Diff guards仍是3b签字136→145。授权GitHub连接器已取得完整解码日志，私有证据在`/workspace/r5-continue-719e16a8/`；CLI下载跳转失败单列，不以其失败当CI结果。

确定夹具错误：当前basic套件正向catalog、变更前pin和变更后not-current三处仍写143 `ade4...`，实际CI为冻结145 `b03...`，现三处同步当前精确值，143历史suite不改。historicalMigration137两组catalog负例仍安装冻结137的`21fe...`（沿用至142），却调用当前严格145客户端，故在原positive前置就拒绝，随后first-red守卫阻断其余例；不能把这种失败算成负例通过。

历史组只加入测试私有frozen137 catalog client profile：原生产客户端先对该真实旧catalog拒绝；版本profile只允许proof.findFirst及原完整catalog SELECT，固定其全部SQL SHA256 `221e86a74b9450bde6bac57c3f47730e5f872bb7d109f8938047811bb4628115`、零绑定值和唯一完整complete-pin谓词，只把145 expected pin换成冻结137 expected pin，其余SQL字节、真实PG返回、guard／权限／属性／四类mutation／原回滚与catalog恢复断言全部保留。其他SQL、后置barrier、参数和写入拒绝；仅两组历史catalog调用使用，不进入业务审核链，不让生产接受旧pin。9项新离线边界和原当前生产pin单测通过，四套最终376/376，前缀12/12；前述367是此前批次，不重复计数。

另有必须保留的新事实：常规CI原maximum测试已被自动执行，prepare返回29271ms（281查询／4 E4查询／1具名屏障），在原30000ms内；之后无submit／formal summary或完整阶段oracle完成收据，最终整例600000ms超时。源代码在prepare日志后依次有计数／根检查、完整冻结oracle及submit，但没有各步进入回执，故精确卡点、失败后业务状态与资源闭合仍UNKNOWN。这个结果是满额prepare的一次正面观测，不是满额全链PASS；“145专用满额未派发”和“常规最大用例已执行失败”须分开记录，不再笼统称满额NOT_RUN。四个correction用例在beforeEach120秒、visual五个用例在beforeAll30秒超时；不把它们归因于pin或并发，也不增加预算或重跑。

下一次145专用满额仍需前节明确范围和新入口支持；必须在每个昂贵fixture／oracle／submit步骤前后保留可闭合收据及原窗口，不等整例600秒后仍不知道停在哪一步。原CI包含maximum，因此普通推送也会触发该原考卷；在“不擅自重跑满额”的当前指示下，先完成本地补丁／轻量验证及提交，推送前须明确是否授权下一轮完整required CI所含的最大用例，不能通过删测／跳过它来取得绿灯。

历史catalog修复的冻结设施闭合：仅migration新增八段严格候选→原始字节逆映射，原全文`7682…`与refs`9ceb…`不变；共享设施比较限定当前helper全文SHA、唯一八绑定段SHA及还原后的旧helper全文SHA，再执行原两文件相等断言。scale全文仍为`50a090de9193d80ab659852c0420aed4e05290913be1050b5f5631da9cf17ed6`，五个实际oracle函数、driver和phase来源钉子逐字不动。最终127项聚焦离线全部通过（另560项未选择），覆盖原完整闭合与8项新篡改负例；首次候选的2项离线失败及其修正收据另存，不抹去失败。跨模型静态复核无剩余阻断；四项真实历史catalog小验证实际收据如下，不冒充整套历史suite已通过。

本轮只运行一次W98四项历史137 catalog小验证，4通过／0失败，另683项未选择；完整进程270197ms（Jest suite260274ms），含加载、基线迁移、夹具及关闭，不作为业务性能或CI环境收益。真实PG通过当前生产客户端拒绝旧pin、历史profile合法positive、四类mutation拒绝及原catalog回滚恢复；原预算未改。正常关闭后独立PG16观测库／连接／租约backend／租约锁均0，未发TERM或使用FORCE，既有容器保留。没有重跑第二组重复用例、basic完整fixture、correction、visual、500或最大例；未将本地四项推广为最新required CI全绿。最终源级lint与三项文档check均退出0；完整quick／全量typecheck和完整E2E本轮未跑。

本次还暴露测试组织的耦合：历史catalog测试、来源逆映射及共享设施比较绑定整份大型spec，而诊断器又将scale整文件作为oracle容器钉住。外围夹具修复会传播到不相关的冻结校验。当前用精确逆映射保留旧来源，未重新pin或移动oracle；后续如解耦，应另审独立冻结oracle模块及其完整来源／函数摘要与反向损坏测试，不能在本轮顺手改结构。


### 2026-10-15 maximum 阶段取证工程补齐（本地，未重跑）

原常规CI run38749797740的maximum是613.943秒suite失败、600000ms整例超时，窗口包含fixture；prepare回执29271ms／281查询／4 E4查询／1屏障，不能写成“prepare后又运行600秒”。14:27的相邻日志是Jest BufferedConsole交付时间，不是实际阶段UTC；无完整oracle／submit完成收据，精确卡点及最终业务／资源状态仍UNKNOWN。

本刀在原maximum增加20个顺序阶段的ENTER／COMPLETE／FAILED／INCOMPLETE收据，覆盖fixture、prepare设置与请求、证明读取、完整oracle、submit、ledger、summary、终态oracle、后探针和observed客户端关闭。使用事件自身UTC／单调耗时、同步私有独占JSONL及直接stderr，最多64事件／32KiB；默认mkdtemp独立目录，文件0600，无SQL、业务载荷或标识。原600000ms整例、30000ms prepare、事务／查询预算及所有旧断言不变。CLEANUP仅表示observed客户端关闭，不代表Nest／数据库／租约四零；Jest超时不取消仍在运行的业务，只有ENTER不能推断提交／回滚。未修改workflow artifact收集，不能称JSONL已可从CI下载。

跨模型只读复核发现的两项问题均已修复：实际prepare异常用存在性wrapper与Object.is分流；真实成功立即记OK，COMPLETE／下一ENTER写入失败直接保留，不进入旧roots／EXPLAIN／零行诊断。可靠闭合要求20阶段全部COMPLETE并且无failed／pending／unavailable；末阶段FAILED或INCOMPLETE均拒绝。新增实际源码块执行的两种sink故障及末阶段两种不完整测试，保留原业务异常、返回值和清理异常身份。

冻结校验不重签旧oracle：严格候选全文→唯一片段→恢复全文，scale仍恢复到50a090de…、migration counterpart到d6c887c0…；所有完整JSON、FULL JOIN、root和双guard保持。另修复上一提交三处145 pin镜像使ordinary driver旧全文绑定过期的问题：只对内存源码恢复这三处并核对46c31154…，再抽取原三个oracle函数；真实E2E及生产仍为145 pin，任意正文／pin篡改先拒绝。旧prepare离线接线注入真实内存stage实例，继续执行当前源码，旧行为断言不变。

本轮仅本地定向与离线检查：阶段、driver和原接线三套185项全通过，无跳过；另两套147项完整源码恢复校验通过（763项未选择；数据库用例未运行，unit配置无全局数据库setup、W98未开）。证据包/workspace/r5-stage-active-74834ad9保留全部结果。此前在校验进程读取源码期间更改候选导致的两项摘要失败、ordinary旧绑定失败及旧VM缺stage依赖均保留日志，已由固定源码复验闭合。不重跑maximum、不推送、不改SQL／pin／预算或人工签字；3b／Trusted和生产条件仍hold。


### 2026-10-15 E5 正式模式工程门控（本地，默认off）

沿本轮“继续推进”授权交付active parser／原生写准入及旧ContributionRule管理三写门，不重新决定已冻结的新run选择、历史legacy、更正继承、明确零政策、缺失阻塞和off规则。精确active在四种APP_ENV可解析，默认仍off；fixture仍仅test。新run在原锁内全活动D4来源、V9冻结政策链与原规模校验下选择policy_v1，历史legacy及其更正不转换；独立v1.1／maintenance门、原幂等回执顺序及所有原SQL／pin／双guard／预算保持。

active时旧规则create／update／softDelete在原RBAC后、任何事务／查询／审计前返回23013／HTTP409；列表／详情和legacy计算读面保留。active→off按既有兼容语义恢复旧规则管理写，本刀没有永久只读cutover latch；生产目标／切换时间／恢复执行仍须发布阶段批准，未改实际环境值或开关。

证据口径：先跑旧规则7项characterization再改编排；E5等七套未再改动用例3383项通过，阶段26项及原诊断159项在最终三套185项全通过；另147项源码恢复通过，无数据库或maximum执行。全三段typecheck通过，离线OpenAPI装配／生成通过，13份client仅inputDigest更新；counts／codemap／rbacmap／readtax／client新鲜度检查通过。query原全量桶／切片超限与冻结来源拒绝用例随既有套件执行；新增service完整proof用例的reader为mock，只证明锁内proof传参和重放顺序，不是新增容量、真实HTTP或受限生产身份验收。原2000／10000／50000／8000／40000上限不降低，生产时延仍未证明。

生成API只改变旧规则三个写operation的23013／409描述，路由与components.schemas均不变，离线契约语义diff为空。授权manifest663条policy entries逐项相同，仅摘要及源码行号变化。契约snapshot与ROUTE_AUTHZ两份仓内文件需维护者grant，当前没有令牌；已在证据包生成85行和56行可审补丁，未修改这两个受保护文件。故E5工程实现已本地提交，不声明派生契约闭合、required CI全绿、Ready或可发布；补齐grant后应用精确补丁并校验才可关闭该缺口。3b、Trusted及生产硬门不由本提交代签。


### 2026-10-15 E5 独立小型HTTP补验（无数据库）

在未获两份受保护文件grant期间，追加只依赖非保护新spec的6项HTTP错误响应测试：真实Controller／Service／AllExceptionsFilter及ResponseInterceptor，小型TestModule使用合成principal、RBAC／Prisma／Audit doubles，不启动AppModule、不连接数据库、不改环境。POST／PATCH／DELETE均实际返回409／23013，DELETE原204声明不吞错误；RBAC先拒时三条路由实际返回403／30100，事务和审计均未调用。6项与原配置230项、旧规则18项合计254通过，定向lint通过，跨模型静态复核无阻断；app.close在afterAll执行。

本验证仅补HTTP路由和Filter错误封装，未安装ValidationPipe或JWT／route guard，不代表参数校验、真实认证／授权、真实DB全链、容量或恢复执行验收。现有active锁内proof单测仍使用mock reader；真实active小链、更正／撤权／并发／恢复矩阵未据此关闭。两份受保护候选补丁与既有84文件证据包保持原摘要，可审且未应用；grant执行路径、精确命令、影响及最小后续计划已保存至/workspace/r5-e5-morning-handoff-81ae6537/MORNING.md。未运行最大例、推送、CI或生产操作。

### 2026-10-17 受限原生首发候选（实施中，未验收容量）

本轮沿维护者“赶紧推进啊”（Sentinel_86e1d92c3a8c81919052edfbf1812b2f，回应 Sentinel_c166e3ea8aac81919e14c067843f7dac）实施受限首发。A／B 隔离对照已结束，不再重跑或接回失败候选。B r2 实际消耗 restore1／fixture1／performance4／logical semantics39，65.573秒、retry0、清理四零；全调用均值72.8475→82.6565ms，目标段28.4225→32.1275ms，B无收益，REJECTED。此前 r1、run38906073016 的失败及 NOT_RUN 保留，不以本轮单测覆盖或改判。原失败34.619秒／P2028继续是失败。

**目标与授权**：给现有全活动原生结算一个统一、可拒绝的首发范围；完成最小代码、针对性单元／静态证明和精确现场验证计划，沿原Draft PR1380集成。授权包括同范围代码、测试、交接及提交准备，不代表部署、真实队员操作、历史转换或放宽原30秒事务。安全隔离测试不得超此前尺寸／资源预算；任何扩大须先列明差额。禁止改已发布migration、原SQL算法／双guard、Trusted门禁、生产库、满额实验及未验证真实映射。

准入集中在 `activity-contribution-launch-policy.ts`；Service只选择active新业务，Query收集同事务冻结事实，纯函数判断上限。候选上限是工程约束，**不是500容量已经通过的结论**：

| 成本维度 | active新业务上限 |
|---|---|
| 全活动身份（含excluded、pending、absent、无source） | 500 |
| 全活动current服务段／最新allocation | 各500 |
| 物理slice／E4 source refs | 各2500 |
| D4 bucket／D4 bucket source／E4 evaluation units | 各2000，分别计数 |
| 活动输入历史 | punch events2000、全部segment revisions1000、全部allocation revisions1000 |
| 冻结贡献policy | 1个version、累计1个role／4个category／8个band，每category最多2个band |
| 冻结time policy／规则snapshot | 各1个version／snapshot，time policy最多1个role mapping |
| 冻结选择 | selection items与resolved scopes各≤32 |
| UTF-8 JSON字节 | 每policy definition≤8KiB，snapshot≤256KiB，selection≤64KiB，完整source输入／D4输出各≤4MiB，E4 evaluations≤8MiB |
| 拆日工作 | 每个物理slice和完整闭合服务段至多2个北京自然日（结束时刻不含）；每个展开输入及E4实际day rows各≤5000 |

按完整活动聚合判断，调用方不能传入子集、分页或分批绕过。D4在锁后重读来源，过滤有效／present之前检查manifest和实际物理slice；全部锁定身份也复核数量。草稿同时计入本次投影与未重建的保留段，写后仍在原事务内复核实际活动成本，历史输入溢出也回滚。新纠错在resumable返回之后、创建版本之前检查完整活动及输入；无时长变化时检查旧冻结证明的实际复制规模和政策形状，不重新计算当前政策奖励。变时长纠错在指纹计算前限JSON／数组成本，再对实际slice、group和evaluation输出复核。短manual slice不能掩盖完整长服务段的拆日成本。

超界复用20225／HTTP409“活动分类结算规模超过本次处理上限”；无截断、无新错误码或重试。可能已在同一事务写入的临时D4／纠错行必须整体回滚，不能留下已提交半成品。原鉴权及等待后复核、命令幂等、完整原生guard、账本／奖励一致性与真实COMMIT仍必需。fixture保留原正确性限制，不证明active容量；legacy、旧回执、已有prepared及resumable恢复不附加这套新业务门槛。默认off、active→off兼容和原30秒预算均不变。

**DoD与探针队列**：①共享边界及上述真实完整输入接线；②针对性边界／越界、过滤前计数、政策／bytes／day、回放与原guard的单测；③跨模型只读复核；④当前候选全本地检查、受影响生成物和交接；⑤下述exact-SHA active现场全链及required CI。①–④只产生工程候选，⑤未完成不能宣布受限首发可交付。原R5全域容量、真实映射、前端回执、人工3b／4b与Trusted、线上fleet及D8-OPS仍独立开放。

**现场验证计划（本轮准备派发受限子集，其余保留NOT_RUN）**：

1. 固定最终完整SHA及源码清单，不借b982历史绿；仅使用srvf-nest-api云内已核验的隔离PG16集群，记录system_identifier、owner／ACL、PG／扩展、146条migration及guard函数／catalog、196表基线和冻结oracle。旧快照生成时没有直接archive-SHA↔cluster-ID记录，只能陈述已有连续性推断，不能补造历史证明。无`--no-owner`，不关guard、不伪造业务状态。
2. 先以当前active应用真实完成政策激活、选择、发布冻结、原打卡／封场／草稿／allocation、prepare、submit、首次审核、账本prepare／post与实际COMMIT，比较不可变oracle、评价及三类账本；实测包含全部鉴权和双guard的30秒事务耗时。fixture-only快照注入不作为正式active入场证明。
3. 正边界一组为500身份、500段／allocation、2500slice、2000units，单简单政策，全部来源与输出不裁剪。负边界分别独立构造501身份（含excluded及无source）、501current段、2501slice、2001units、超policy／bytes、长完整段＋短slice；检查明确20225和独立事务读取的业务零增量。政策、bytes和day边界须与人数解耦。
4. 同键同载荷重放、冲突载荷、等待后撤权、提交／首次审核／guard／COMMIT失败回滚分别留证；准备已有任务后切off，禁止新原生业务且重放原回执，恢复active后仅恢复原未完成任务、账本不重复。纠错覆盖变时长、unchanged-time复制以及准备中任务恢复。最终独立连接验证无业务半成品、租约／连接／子进程／临时库归零，失败保留原错误与NOT_RUN，retry0。
5. **尺寸／资源差额必须先确认**：此前小fixture至多4身份／16units／80refs，restore1／fixture1／performance4／semantics≤40、总600秒。本正边界将身份扩大125倍、units125倍、refs31.25倍；负边界需要独立合法fixture，多入口active／off／恢复语义也不能挤作原39项oracle。常规PR CI仍含原2000身份／10000段／50000slice最大例，超本首发范围；本轮不派发、也不删改其断言。先交付具体候选与本计划，未经范围调整不自动触发该最大例，不把跳过CI当通过。

后续接管消息明确要求“先推进不依赖它的测试和当前SHA的容量边界验证”，本轮据此准备一个新受限窗口：一个全新w98隔离库、一个真实发布的500身份活动，原生prepare正边界一次及501身份／501current段／2501物理slice反例各一次；反例输入置于原30秒事务内并回滚，逐次独立核对196表指纹。不重跑A／B、不更改其已用计数、不跑原2000满额；仍保留总600秒、4次容量prepare测量、≤40项逻辑语义及retry0，所有未执行项保持NOT_RUN。2001 units在500段×4类别的其余边界内不能独立构造，保留前后双重unit检查的内存回归，不伪造合法超额证明。现场精确SHA、结果和清理以本轮外部执行日志／PR报告为准，不在此预填通过。

**精确写集**：新增共享launch policy及其spec；修改contribution query／service及对应spec、time query／service及对应spec、settlement-draft service、correction-application service；同步本节、admin交接、changelog fragment、生成CODEMAP；ROUTE_AUTHZ候选补丁另留待维护者授权。路由／DTO／schema／migration／workflow／全局配置／SQL evaluator不改；domain-map元数据输入未变。ROUTE_AUTHZ实际生成差异仅两处输入摘要，663条权限声明不变；主文件已恢复HEAD，限制来源是AGENTS.md §1与harness/redzone.json，生成命令`pnpm docs:authz`，不自行发放令牌或代批Trusted。现有9837d091已解决的旧派生物问题不重新记为本轮缺口。

### 2026-10-17 受限候选实际验证收口（容量 NOT_RUN）

最新接管指令明确：500边界所需的正常隔离验证在已批受限首发内，不因相对四人夹具的倍率另设业务批准门槛。本轮已执行当前业务代码提交 `8385d67b8d0a2d1e1b143eb4383b7e0d6b206835` 的现场验证；本节是结果记录，不增加下一次运行授权。共享准入、完整服务段拆日防线及跨模型复核已经完成，仍不能据此宣布容量验收通过。

| 项目           | 实际结果                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向单元／类型 | 6套300项通过；root、scripts、test三段typecheck通过。完整段很长但manual slice很短的膨胀反例保留                                                                                                                |
| 全单元首次命令 | 460套通过／1套失败，10254通过／1失败／5 todo；失败为未修改CLI用例遇到全局pnpm11默认自动安装与环境目录问题。以`pnpm_config_verify_deps_before_run=false`单独复核该原套件32／32通过，不倒签首次全命令为绿       |
| 必需冷lint     | 原300秒上限下src1468文件及test536文件各退出0，prisma阶段总墙钟300.121秒停止，整体FAIL_WINDOW_EXCEEDED。余下prisma及新增policy独立lint退出0，不冒充聚合命令通过                                                |
| 其他静态       | diff、CODEMAP、边界元数据、离线OpenAPI与client新鲜度通过；harness guards为571通过／2失败／1已知缺口，两个失败对应受保护ROUTE_AUTHZ摘要未应用                                                                  |
| 首次现场夹具   | 64.022秒，在真实seal返回409／20043：原始punch尚未投影到闭合段。容量prepare0次；保留失败，关闭应用／observer、正常DROP本人测试库并释放lease，独立四零                                                          |
| 夹具修复与续行 | 按原E5原始输入夹具补齐与每人双punch关联的closed draft segment；发布、seal、generate仍走真实命令，不直接写证明或账本。沿同一保守600秒墙钟续行，计入首次失败与修复间隔，不重置预算                              |
| 最终停止       | 500条真实allocate阶段通过300条完成里程碑后，执行额度耗尽。共同墙钟510.759秒（原运行器保留90秒清理余量）；精确最终分配数未持久化，记UNKNOWN，不把300里程碑当最终数量                                           |
| 实际计数       | restore0；顺序新建隔离库2个、同时最多1个；fixture construction2次、重建1次；capacity prepare **0／4**、capacity retry0；语义检查分组6／40。这6组是迁移／catalog／真实发布前置证明，不是容量或冻结oracle通过数 |
| 清理           | 两次均关闭应用和observer、正常DROP本人隔离库、释放lease；databases／clients／leaseBackends／leaseLocks均0／0／0／0。没有FORCE或未知后台资源                                                                   |

本轮四项实际容量调用（500正边界、501身份、501current段、2501物理slice）及其196表回滚比较、冻结oracle、active／off回放恢复、500 submit／双审／账本COMMIT均 **NOT_RUN**。政策／bytes／完整长段的真实数据库反例、纠错、等待后撤权及独立deferred COMMIT反例也未执行；这些边界仅有上述针对性单测证明。失败原因是现场夹具构建和共同窗口消耗，不能表述为原生prepare性能失败或通过。没有增加运行窗口、重跑A／B或追加满额；旧run38906073016的34.619秒／P2028仍为FAIL。

受保护候选仍仅为 `docs/ai-harness/ROUTE_AUTHZ.md` 两处inputDigest；生成命令`pnpm docs:authz`对应`tsx scripts/generate-authz-manifest.ts --write`。663条entries及其余manifest字段逐项相同，当前候选digest为`01eb12c434fbc04763c50ed8640ce8b41cb340c9b844d98bca5ae08b9309ea37`；补丁SHA256 `f577af2a55b6a49194534a392351a097fa8f98417667027a5e580d190170083d`。AGENTS.md §1及harness/redzone.json规定维护者grant，AI不自发令牌；主文件未包含候选差异，未绕过Trusted。该文档缺口没有阻止本轮隔离执行。

原始执行日志、两份实际运行器、完整源码hash清单、两份journal／cleanup、静态结果及可审代码／生成物补丁保存在云端`/workspace/r5-limited-native-20261017/`。后续文档提交不改变上述被测业务代码；不得把文档HEAD当成重新执行过的数据库SHA。PR1380继续Draft；required CI、当前代码完整容量链、人工签字及生产Gate未关闭。

**本次未做：** 未追加容量重跑／原2000满额、未改原30秒事务或SQL／双guard／migration／默认开关、未改生产库或用户Mac、未部署／合并／Ready、未代发红区授权或代签Trusted。

### 2026-10-17 夹具契约修复与极小先行验证（执行前记录）

接管续令要求在已授权范围先修测试设施，以相同入口极小夹具完整走通真实发布、prepare、confirm、回滚、off／恢复和清理，之后才验证500边界；不再次直接跑500，不增加满额实验，不重复索取同范围修复批准。当前仅增加共享原始夹具与离线合同spec，业务代码仍为8385d67b8d0a2d1e1b143eb4383b7e0d6b206835，无SQL／guard／migration或既有e2e断言变更。

原始日志精确分解510759.462ms：首次含清理64022.232ms、修复及续行前间隔220782.545ms、第二次allocate前64359.094ms、实际allocate循环161173.224ms、第二次清理及残差422.366ms。真实观测窗分别49956.015／50274.019ms，已包含于REAL_PUBLICATION，不重复相加。首次20043是缺少双punch到闭合段的投影；第二次在下一条allocate前耗尽600秒扣90秒清理余量，未调用prepare，不能归为prepare性能。旧日志只证明分配成功300至399条，精确末值UNKNOWN。

共享夹具在真实seal前核验每个身份恰有双punch及同身份闭合段，5个相邻物理slice覆盖4类别，保留真实政策激活／选择／发布快照。静态发现旧未执行尾部把全部正式账本行数当人数；原服务合同每结果／日期写service_credit与contribution_credit两条，故分别核成对分录及delta、分类秒数manifest与submitted buckets、成员日版本与已提交合计，保留原冻结oracle与账本guard，不以只改单值掩盖业务问题。离线合同8项通过，类型／定向lint通过；这些均非数据库验收。

本次现场执行器先固定提交和源码SHA，顺序新建1人、500人两库（同时最多1库，正常阶段而非重试），restore0、常驻连接最多3、同一600秒脚本入口时钟、90秒清理保留和原30秒事务不变。极小场景成功prepare及审计后故障回滚prepare各一次，明确记为2次语义prepare；500仍最多4次容量prepare，所有HTTP回放／拒绝与语义检查分组分别持久化，分组上限40、retry0。极小全链及清理四零失败即停，500记NOT_RUN。故障注入先执行原audit再抛错，证明真实评价／receipt写入回滚，早于deferred barrier，不冒称guard提交负例。执行前不得预填结果。

权限文档两处摘要的维护者精确命令另见云端/workspace/r5-native-fixture-repair-20261017/MAINTAINER-AUTHZ.md；主ROUTE_AUTHZ保持HEAD，AI不索取或生成令牌、不代批Trusted。本次未做：尚未执行新数据库场景、A／B重跑、原2000满额、生产或Mac操作；未把旧失败或未执行项改判为通过。

### 2026-10-17 统一夹具真实全链与500边界实际结果

测试提交 `9c5c60d6b0d0d86f0e4a7c178026756bf674a6f2`（src／prisma仍与8385d67b8d0a2d1e1b143eb4383b7e0d6b206835一致），唯一统一执行器exit0。先1人真实全链及清理通过，再沿同一时钟验证500；没有重启A／B或重置窗口。

| 项目 | 实际结果 |
| --- | --- |
| 预算 | 共461.561110秒／600秒，含脚本入口模块加载、两场景与清理；ts-node进入脚本前bootstrap不含。原30秒事务、90秒清理保留不变 |
| 精确计数 | restore0；正常顺序新库2、同时1；fixture阶段2、retry0；容量prepare4／4；语义检查分组32／40 |
| tiny | 93.239375秒完成真实发布、封存、generate、HTTP allocate／prepare／submit、off旧receipt回放／新prepare20222拒绝、恢复active、双审、账本COMMIT及重放 |
| 故障回滚 | 原audit写入后同tx确认4 evaluations和1receipt后抛错，真实HTTP500／50000，196表回基线；早于deferred barrier，不冒称其COMMIT负例 |
| 500分配 | 500／500真实HTTP commands COMMITTED，阶段248.024633秒；全活动500身份／500段／2500物理slice／2000buckets及evaluation units，source manifest1075294 bytes |
| 正例prepare | 完整HTTP调用13.535153秒；含记录的外层阶段13.623942秒；真实原SQL／双guard／事务COMMIT通过 |
| 反例 | 501身份含excluded、501current段含voided、2501slice均实际进入prepare并20225拒绝，每次196表独立observer指纹与基线相同。2501真实allocate已先完成，异常栈在prepare；外层真实事务委托不等同独立HTTP或deferredCOMMIT负例 |
| oracle | tiny4、500为2000，draft及submitted原冻结oracle／root hash／day均零差异 |
| 最终入账 | 500 submit、双审、ledger prepare／chunks／finalize及COMMIT完成，重放不重复写。按实际(resultRevisionId,ledgerDate)核唯一两类分录配对；本单段单日夹具500对／1000行，5.00小时、250.00分，不推广为人数通式 |
| 分类及日状态 | classified2000行／17500秒，逐项对submitted buckets／manifest；500 member-day，version1、各0.50分及latestBatch一致 |
| 清理 | 两场景均app／observer关闭、正常DROP本人库、lease释放；独立四零0／0／0／0，pending0、UNKNOWN=false，无FORCE；catalog前后不变 |

prepare入口共9条：容量正例HTTP1＋service反例3；tiny故障／成功HTTP各1＋off新拒绝service1；tiny active／off旧receipt HTTP回放2。32／40是检查分组，不能当HTTP调用总数。双审／账本调用原服务，不声明全部HTTP或部署worker图覆盖。共享helper SHA256 `93dad78ccb7caab3e57b85f5183232b4a99bcd69997e8660d66a50f22063f9e9`；实际执行器SHA256 `d25ee5639b7172284d6c374c2574e71894b30240686cb6da4aca45af891f537d`。新离线合同8项、定向lint、执行器类型及无DB预检通过；一次误用普通e2e配置在范围守卫处触库前被拒，保留失败，不计数据库执行。

证据目录/workspace/r5-native-fixture-repair-20261017，完整结果RESULT.md、result-summary.json、execution/summary.json及逐场journal／cleanup／source-manifest；维护者两处权限摘要命令为MAINTAINER-AUTHZ.md。旧0／4与510秒失败保留；本轮只是关闭以上受限现场子集，run38906073016的34.619秒／P2028仍FAIL，B仍REJECTED。ROUTE_AUTHZ主文件未改，required CI、原cold lint及权限摘要缺口／Trusted／人工门不据此关闭，PR1380保持Draft。

**本次未做：** 未追加实验、真实纠错／等待撤权／独立deferred COMMIT／policy或bytes或长段DB反例／原2000满额；未操作生产或用户Mac、未部署／开关／Ready／合并；未自发grant或代批Trusted。

### 2026-10-17 同范围收尾：语义预算、历史证据与真实交付门

收尾开始时本地、远端与PR HEAD均为`edbeaf7c90aebc17c697d7cdfc0ee1b4e9c6885a`；数据库实测仍为9c5c60d6，之后只补文档，src／prisma不变。没有重新打开600秒窗口，容量4／4及语义32／40计数不增加。40是语义检查**分组上限**，原始32组为tiny15＋capacity500为17；余下8个名额未分配项目，不存在可逐项命名的“第33–40项验收”，更不能用容量4／4覆盖其他路径。

核对原现场计划及历史记录后，必须区分本轮未跑与从未有证据：

| 主题 | 当前可复用证据／仍开放部分 |
| --- | --- |
| 等待后撤权、旧JWT资格／成员失效、跨日多session、active→off兼容、独立worker恢复 | `e5-active-matrix-validation.json`记录3＋1＋8＝12项真实DB通过；10个相关源码／spec／helper SHA与当前逐字相同，审核修复两源码亦相同。原worker／账本／submit／access代码未变，无需因本轮32组不包含它们就重跑 |
| 冲突payload、原生statement／deferred COMMIT回滚 | `e4-146-validation.json`已有freshEntry exactReplaysAndConflicts及nativeStatementAndDeferredCommitRollback记录，原SQL未变；历史通过不计入本轮32组，tiny故障仍不冒称deferred负例 |
| 变时长／unchanged-time纠错算法 | 历史active两类纠错正确性可复用；新增前置活动检查、旧证明复制规模及变时长bytes／count／day准入接线尚无当前DB证明，保持NOT_RUN |
| 与人数解耦的policy／bytes／长完整段+短manual slice反例 | 原计划要求真实拒绝及同事务零增量，本轮只跑既定三种人数／段／slice反例；上述维度仅单测通过，现场保持NOT_RUN |
| 分阶段失败／准备中恢复细项 | 逐项核已有有效生命周期证据，不追加整套审核／恢复实验；旧final native-guard callback rejection只提供mock单测，两个纠错用例名称也不能直接证明“重启后准备中恢复”。未有PG证据的具体项不填通过 |

历史JSON的sourceHashes与sourceVersionBoundary一并解释；baseCommit=b9e9是修复前基线，不当作验证源码的唯一标识。旧临时raw-result在当前executor不存在，本次核对现存仓内记录及源码SHA，没有冒称重新核验缺失原文件。E4 concurrency／correction默认helper为fixture，只有`SRVF_E5_ACTIVE_MATRIX=1`才是active；普通CI绿或spec存在不自动补证。2001units独立合法构造限制及原2000最大例不属于本次500验收的边界保持原文。

本次继续串行完成非DB检查：修正pnpm自动依赖安装环境后的完整单元组exit0，461套、10255项、8快照通过，5个原todo保留；Jest193.799秒，外层195.069秒。旧460套通过／1套失败结果不倒签。当前唯一冷lint仍exit1／WINDOW_EXCEEDED：src1468文件178.128秒退出0，test538文件在总300.314秒SIGTERM，prisma未运行；未延长300秒、未重试。`scripts/check-cold-lint.ts`为enforcement-layer红区，当前无grant，未自行修改裁判。

当前`docs:authz:check`失败仅两处ROUTE_AUTHZ输入摘要；663条entries及其他字节不变，主文件未改。维护者在云端本人执行：`pnpm harness:grant 'docs/ai-harness/ROUTE_AUTHZ.md' --reason 'PR1380：仅同步生成的两处inputDigest，663条权限声明无语义变化；Trusted审批独立'`，随后`pnpm docs:authz`、`pnpm docs:authz:check`与两处字节独立核对；完整可复制命令和断言见原结果包MAINTAINER-AUTHZ.md及收尾补充CLOSEOUT.md。pnpm环境沿用`pnpm_config_verify_deps_before_run=false`。grant由维护者本人执行的限制来自AGENTS.md §1“AI不得自行发放授权”，只解写权限，不解合并／Trusted。

另实跑既有`cutover:check:signoff`为exit1：16项读数非退化，但3b签字migration-total136、实际146。137–146条SQL目录及完整SHA列于补充migrations-137-146.json，须维护者实际审查认可后按原流程重签，不能机械改计数或代签；本次未发现4b读数漂移，不增添重签要求。

GitHub当前普通CI没有新SHA结果；仓内声明required为`Lint / Typecheck / E2E`与`Docker image build`，经典保护API403，`gh pr checks --required`未报告检查，不解释为无需CI。旧run38858575751属于9837d091：Diff guards在既有3b闸失败，E2E4亦失败；其余旧绿不替代当前证明。收尾开始时Trusted run39031898004的scan成功、approval WAITING。普通ci.yml无手动受限参数入口且会收集被禁止原最大例，本轮不触发整套、不删断言或代报绿；需要维护者确定符合该限制的执行入口，或另行明确必要的CI范围调整。最终SHA及Trusted状态见补充github-final.json，仍保持Draft／BLOCKED。

剩余Release5必要项只保留：新增准入真实反例与新纠错gate集成、缺证的具体生命周期细项；原300秒lint及生成物／3b对拍修复；最终SHA required CI和既有Trusted人工门。真实映射／影子对账、前端契约发布回执、exact deployed SHA／fleet／稳定窗、只读及worker排空、D8-OPS两次现场授权仍仅在生产启用时按原边界完成，不混入本次容量窗口追加实验。

收尾补充目录/workspace/r5-release5-closure-20261017。原结果ZIP SHA256 `a2ac5e4924f5dfcb227a9f8c0e014f200cc2639a2598722d012d604e63f5e8d1`与Library `libfile_51b7d5b89ba48191b92d1a17d635898e`保持不变，旧满额失败及B REJECTED不改判。

**本次未做：** 未追加数据库实验／A／B／原满额，未运行包含原最大例的整套CI；未改生产SQL／guard／预算／workflow／旧断言；未读写生产或用户Mac、未Ready／合并／部署／开关、未自行grant或代签3b／Trusted。

### 2026-10-17 冷lint与受限普通CI续行收口

最新状态见[受限CI收尾与维护者动作](activity-os-r5-limited-ci-closeout-20261017.md)：两CLI候选在原300秒内完成2007文件，272.441秒、零诊断；正式受保护入口尚待本人grant。唯一新小夹具窗口在REAL_GENERATE失败，prepare0，2组通过／1组失败／5组NOT_RUN，正常清理四零；未重试。首个政策门原已在generate，夹具已修正到首次准入，离线11项、类型及定向lint通过，实际修复后DB验证待普通CI。新增原生业务及全部仍适用测试保留；原满额仅拟精确隔离为历史／手动入口，不将其填绿。旧9c5c60d6的500通过证据及旧满额失败均保持。五个精确grant、137–146条SQL本人3b与最终SHA Trusted的位置及命令见该文档；无需用户在Mac运行云路径。

**本次未做：** 未应用尚无grant的CI／lint／权限生成物候选，未重复数据库或500／满额，未改生产SQL／guard／既有断言，未代签3b／Trusted、Ready／合并／部署。
