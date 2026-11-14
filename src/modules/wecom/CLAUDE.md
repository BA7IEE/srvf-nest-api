# wecom — 企业微信通道边界

wecom（corpId+wecomUserId）与wechat小程序（openid）分表、分码、分密钥、分常量、分渠道，
不共用数值恰好相同的配置，不写User.openid。
本模块负责settings/provider/OAuth attempt，身份写归auth/users，
消息outbox/受众/delivery归notifications，依赖单向。
设计见 `docs/archive/reviews/wecom-integration-t0-terminal-review.md`；
生产loginEnabled/messageEnabled仍须真实HTTPS/T6及维护者批准。

## 配置与并发

- settings每次直读PG；constant unique保证singleton，首次竞争P2002后重跑同事务命中现行，
  不造新错误码。read-modify-write先取id→FOR UPDATE→重读完整行→dto终态→组合校验→写。
- enabled/loginEnabled/messageEnabled默认false，二级true须总闸true；
  关闭总闸一切Effect拒绝。登录再查loginEnabled和corpId，DEV_STUB也必须有corpId。
  resolveRoute不代判messageEnabled，消息在publish和Effect锁后分别复核。
  绑定事务自身必须锁后复核enabled/loginEnabled，不能只依赖resolveLoginContext。
- corpId仅在旧corpId的active identity计数为0时可改，否则36020，计数在settings锁内。
  webBaseUrl只准origin，拒path/query/fragment，production-like必须HTTPS。
- RealProvider唯一入口prepare(settings)返回绑定不可变ctx的新对象；
  不implements裸WecomProvider，不补实例方法/this.settings，防单例并发串配置。
- configurationGeneration为effect字段SHA-256、排除remarks，仅进程内等值比较，不出日志/响应。
  token cache可用模块Map，键corpId:agentId:generation；这是允许的provider凭证缓存，
  不是身份/判权缓存。forceRefresh只绕缓存token，仍复用在途refreshPromise。
- AES-256-GCM用独立WECOM_ENCRYPTION_KEY；missing/configured/invalid按实际密文解密判断，
  不自动rotation/重加密。production-like在写入口和resolveRoute双拒DEV_STUB，不fallback。

## 协议与安全

- errcode/agentid/close/userid/access_token/expires_in等缺失或错类型统一fail-closed到36031，
  不用本地配置或默认值伪装上游事实。allow_userinfos/allow_partys/allow_tags整个键缺席才计0，
  出现但结构错也拒绝。errcode分类不依赖errmsg。
- WecomAuthAttemptService是attempt唯一writer，state/ticket仅SHA-256，OAuth code连hash也不存；
  updateMany CAS判写一条SQL，count=1才成功。浏览器nonce/returnPath规则沿auth绑定流程。
- isSafeWecomReturnPath是唯一回跳防线，不放宽；控制字符用数值判定，避免真实控制字节使文件二进制化；
  token-like query key逐段精确匹配，不能退化成漏camelCase或误杀keyword的规则。
- 域错误仅按归一化类型/kind映射：不可用36030，provider36031，登录泛化36010归auth。
  WECOM_ERROR_KIND是必填闭集，由本模块分类一次，不让调用方嗅探errCode字符串。
  普通幂等请求-1至多3次，45009不重试，配置错误终态。
- message/send物理预算1，不做传输重试，退避归outbox；不改变gettoken/agent/get/auth/getuserinfo。
  唯一message/send固定enable_id_trans=0、enable_duplicate_check=1、duplicate_check_interval=1800。
  只touser，无toparty/totag；收到invalidparty/invalidtag不得忽略，按provider-contract-error终止。
  stub故障注入仅非生产测试，不以stub代替T6。
- 不冒泡fetch原始error/cause（可能含带secret/token的URL）。
  CorpSecret明密文/access_token/code/完整URL不入日志/audit/示例；
  corpId响应仅掩码，settings update只记changedFields，reset无before/after/extra。
  test-connection只返诊断，不让成员/部门/标签ID越过service边界。
  reset.credentials仅SA，其余既有settings权限沿ops-admin，不擅改授码。

验证provider畸形响应、并发resolveRoute、settings锁后重读/组合约束、schema与安全响应。
settings-concurrency的调度证据依赖per-worker派生库，完整并发验证交CI；
改DTO/错误码再跑contract，不以普通顺序测试代替并发证明。
