### Added

- **权限说明 ↔ 管辖面绑定闸(P2-13)**:新增 `scripts/check-permission-surface-binding.ts`
  与基线 `harness/permission-surface-baseline.json`,由 `permission-surface-binding.spec.ts`
  在 unit 轮执法。**一条已有权限码长出新端点、而它的 `businessDescription` 一字未改 ⇒ 红,并点名是哪条码。**

  它关掉的是这个洞:**权限码总数不变,不能证明权限说明没过期**。B7 受众标签那批加了
  **3 个新端点、零个新权限码**,`member.read.record` / `member.update.record` /
  `activity.publish.record` 三条说明当场过期,**没有任何机器发现** —— 是人工复核抓到的。

  立项前把台账那句断言变成了读数(变异:给 `GET /members/:id/audience-tags` 的
  `@RequiresPermission` 加上已有码 `org.read.node`,该码管辖面 6→7,零个新码,说明一字未动):

  | 既有判据                         | 变异前 | 变异后(未重新生成) | 变异后(重新生成) |
  | -------------------------------- | ------ | ------------------ | ---------------- |
  | `docs:authz:check`               | 绿     | **红**             | **绿**           |
  | `docs:counts:check`(码数)        | 绿     | 绿                 | 绿               |
  | 四桶闭包                         | 绿     | 绿                 | 绿               |
  | `docs:rbacmap:check`(角色持有人) | 绿     | 绿                 | 绿               |

  ⇒ 唯一会红的 `docs:authz:check` 只是「生成物与源不同步」,`pnpm docs:authz` 一跑就绿,
  **而重新生成不碰任何说明**。缺的不是检测,是绑定。

  规模:实测 218 条码有端点、其中 **72 条守多于一个端点**(起草本刀时是 217 / 70 ——
  两周内就漂了),说明过期是结构上必然持续发生。

  执行位在两处,少一处就会被绕过:判据红之外,`--write` **拒绝**推进「面变了而说明没改」的码;
  确实复核过、认定说明仍准确的用 `--acknowledge-unchanged <码>` 显式放行(不写进基线、不跨面生效)。
  基线缺失 / 读空 / 截断一律判红 —— 空基线与空现状比对恒等,那是本仓踩过的假绿形状。

  ⚠️ 本刀**不改任何说明文案**,基线也**不断言当前说明是准确的**;它只钉住「从今天起,面变了必须有人重看说明」。
