# 证书证据留存与清理 SOP

> 冻结稿:[`certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md) v1.2 §15.1 / §15.5 / §15.6 / §8.4。
> 同族 SOP:[`sms-data-retention-sop.md`](./sms-data-retention-sop.md)(同款「维护者手动 psql、**不**引入 cron」口径)。

证书证据图是全系统敏感度最高的一类数据(**L3**):图上可能同时有姓名、证件号、照片、二维码与防伪信息。这份 SOP 只回答两个问题:**它存在哪里**、**什么时候可以删**。

## 一、证据的两个属主(别搞混)

| 证书来源 | 证据在哪 | blob 属主 |
|---|---|---|
| `sourceCode=RECRUITMENT` | `RecruitmentCertificateClaim.imageKeys` | **Claim** |
| `sourceCode=ADMIN` | `ownerType='certificate'` 的 `attachments` 行 | Attachment(走 storage ledger) |

**PR-4b 起 `Certificate` 自己没有 `imageKeys` 列。** 发号**不复制**证据到证书上(§13.5):证书通过 `sourceClaimId` 指回它的申报,读证据时才顺着关系去取。

这一条直接决定清理动作:**删了 Claim 的图,那张已发号证书的证据就没了**。Claim 不是「临时上传暂存区」,它是档案的一部分。

## 二、什么绝不能删

| 对象 | 原因 |
|---|---|
| `status=PROMOTED` 的 Claim 及其 `imageKeys` | 它是某张正式证书「当时凭什么认定」的唯一证据链(§8.5 第 11 步只清重复标量,**保留** Standard/Policy/审核链/图片) |
| 任何 ACTIVE Policy / Standard | 历史证书锁定的规则版本可能已 `RETIRED`,但仍需可读(D-CERT-008) |
| `audit_logs` | 不可变追加,本 SOP 一律不动 |

## 三、可以清理的三类

### ① 被驳回或撤回、且未发号的 Claim 图

```sql
-- 只读:先看规模与最老一条
SELECT status, COUNT(*) AS n, MIN("updatedAt") AS oldest
FROM "RecruitmentCertificateClaim"
WHERE "deletedAt" IS NULL
  AND status IN ('REJECTED', 'WITHDRAWN')
  AND "imageKeys" IS NOT NULL
  AND "updatedAt" < now() - INTERVAL '90 days'
GROUP BY status;
```

确认后取出 key 交给存储侧删对象,再清列:

```sql
-- ⚠️ 先删对象、后清列。反过来会留孤儿对象且再也查不到 key。
SELECT id, "imageKeys" FROM "RecruitmentCertificateClaim"
WHERE "deletedAt" IS NULL
  AND status IN ('REJECTED', 'WITHDRAWN')
  AND "imageKeys" IS NOT NULL
  AND "updatedAt" < now() - INTERVAL '90 days';

-- 对象删完之后:
-- ⚠️ 2026-07-30 跨模型评审 R11 订正:此前这条只清 imageKeys + 打 sensitivePurgedAt,
--    **把申报里的其余再识别字段全留下了**。冻结稿 §15.9 要求的是「清除敏感信息」,
--    而证书编号(L2,可用于外部查询或冒用)、发证机构、发证日 / 到期日
--    三者合起来足以定位到一个具体的人 —— 只删图片等于只清了最显眼的那一项,
--    然后在 `sensitivePurgedAt` 上打了一个「已脱敏」的标记。
--    而 SOP 的筛选条件是 `sensitivePurgedAt IS NULL` —— 打上标记之后这一行**永不再被扫到**,
--    漏清的字段会永久残留。这正是 promote 路径 F12 踩过的同一个坑。
UPDATE "RecruitmentCertificateClaim"
SET "imageKeys"      = NULL,
    "certNumber"     = NULL,
    "issuingOrg"     = NULL,
    "issuedAt"       = NULL,
    "expiredAt"      = NULL,
    "rawCertificateName" = NULL,
    "reviewNote"     = NULL,
    "sensitivePurgedAt" = now()
WHERE id = ANY($1::text[]);
```

> **不清 `standardId` / `recognitionPolicyId` / `status` / 时间戳**:它们是「这条申报当时被判成什么」的档案,不含再识别信息,清掉会让门槛派生与历史统计失去依据。
>
> **`PROMOTED` 行不在本口子内**:发号时已即时清敏(§8.5 第 11 步),且它的标量事实已搬进正式证书。本 SQL 的 `status IN ('REJECTED','WITHDRAWN')` 天然排除。

**删除失败要留可重试标记 —— 别打 `sensitivePurgedAt`。**

存储侧删对象是 best-effort:一批里可能只成功了一部分。**只对确认删成功的那些 id 执行上面的 UPDATE**。删失败的行**保持 `sensitivePurgedAt IS NULL`**,下一轮 SOP 会重新扫到它 —— 这就是重试机制,不需要额外的账本。

反过来做(先整批打标记再删对象)会让删失败的行永久跳出筛选条件,对象和字段都留着,而库里显示「已脱敏」。判断依据只有一条:**`sensitivePurgedAt` 非空 = 这一行的敏感字段确实已经清干净了**。任何让这句话不成立的写法都是错的。

**90 天是建议值,不是铁律** —— 留这么久的理由是申请人可能申诉「我传的明明是对的」,而复核需要原图。缩短前先确认没有在办申诉。

### ② 整份报名被撤销后的 Claim 图

§8.4 末段:整份撤销时未 PROMOTED 的 Claim 在同一事务转 `WITHDRAWN`。它们随 ① 一并清理,不需要单独口子。

### ③ 孤立 storage 对象

指库里已无任何行引用、但对象仍在的 key。它们主要来自「落对象成功但事务回滚」的窗口(代码里 best-effort 删,失败只记安全日志)。

排查靠存储侧列举 `recruitment/certificate-claim/` 前缀,与库内 `imageKeys` 求差集。**这一步不要凭直觉删** —— 差集算错就是删正在用的证据。

## 四、三条硬规矩

**不引入 cron。** 与 SMS retention 同口径:清理是低频、需人判断的动作,自动化的收益远小于「某天 cron 谓词写错、静默删掉一批档案」的代价。本仓两个 cron 槽位已满(§硬禁区:不新增第 3 个 cron)。

**先删对象、后清列。** 顺序反了会留孤儿对象,而且 key 已从库里消失、再也定位不到。

**清理动作本身不写 key 到任何地方。** §15.6 禁 `imageKeys` / signed URL / 图片文件名进日志与审计。要留操作记录就记「清了几条、时间窗、执行人」,不记 key。

## 五、和证据读取端点的关系

`GET /admin/v1/members/:memberId/certificates/:id/evidence-urls` 每次都重新签短 TTL URL(300s)+ `Cache-Control: no-store`,**从不缓存**。所以清理不需要考虑「已发出的 URL 还在生效」——最长 300 秒后自然失效。

前端侧的约束(§23):证据 URL 按需申请、不预加载、页面关闭即丢弃、**不写 localStorage/sessionStorage**、埋点禁止采集 URL。这几条在后端无法强制,属于交接约定 —— 见 [`handoff/admin-web.md`](../handoff/admin-web.md) 的证书工作台段。
