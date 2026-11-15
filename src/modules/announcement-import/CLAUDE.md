# announcement-import — 解析与事务编排

preview/execute分别用announcement-import.preview/execute.record，仅编排锚定解析与逐行结果。
任命/分管校验、closure与audit只在Organizations/PositionAssignments/SupervisionAssignments
各自create中实现；透传meta，不在本模块复制规则、直写audit或新增事件。

- 两端共用request-wide transaction，使用三个create的`{transaction}`入口，
  与单行`{dryRun}`互斥。组织/closure/audit对后续行真实可见；
  每行固定SAVEPOINT保留blocked/already-exists聚合。
  preview计算完整结果后PreviewAbort整批回滚（含audit），execute提交；
  未声明异常整请求回滚。DryRunAbort保持各service私有，不抽公共沙箱工具。
- 第一条Organization/closure查询（包括parentCode/orgCode解析）前取组织固定topology xact lock，
  后续create在同事务重入，不后移或换锁。
- organizations按声明顺序处理，父先于子；orgCodeMap先查、再查tx。
  只建nodeType=group；provisional用establishmentStatusCode，不支持导入队/部/总队节点。
- execute只接受memberNo+orgCode双锚，缺失blocked，不按姓名自动写。
  preview唯一姓名命中也仅suggestedMemberNo+needs-manual，不升级ok。
  批内seen*集合用于稳定重复诊断，不代替service防重。
- organization已存在时只比group类型+已解析parentId，不比名称/设立状态/功能；
  锚一致才already-exists并供后续引用。锚不一致blocked，并加入毒丸集，
  后续positions/supervisions不得绕map经DB解析到错误组织。
  position/supervision的already-exists沿被复用service真实BizCode。
- 仅status的四值闭集是契约；真实BizException原样携code/message，
  合成诊断bizCode=null且message自由文本，不把reasons伪装成稳定枚举。
- establishmentStatusCode/groupFunctionCode可输入，但不自动扩展组织响应字段。
  appointmentSource缺省announcement-2026，仅position行可覆盖，supervision无该字段。
- 导入不自动挂终审RoleBinding，运营另经role-bindings配置POSITION_ASSIGNMENT；
  不在导入里调整权限映射。真实公告姓名/memberNo不得进seed/fixture/测试/文档。

验证preview零写、混合执行、锚冲突毒丸传播、幂等与audit回滚；
改被复用service时连同其组织/任命/分管E2E验证，接口变化再跑contract。
