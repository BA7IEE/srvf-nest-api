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
