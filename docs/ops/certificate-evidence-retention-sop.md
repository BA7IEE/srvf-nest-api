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
UPDATE "RecruitmentCertificateClaim"
SET "imageKeys" = NULL, "sensitivePurgedAt" = now()
WHERE id = ANY($1::text[]);
```

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
