### 三个零产出审计事件处置落地(维护者 2026-08-27 拍板)

P2-23b 摸底发现的 3 个零产出 union 成员,维护者拍板处置,本刀落地:

- `recruitment-application.certificate-upload` / `.certificate-review` ⇒ **已退役**:
  union 注释补〔已退役 · 无产出者〕(生产者随 #830 PR-4a-2 删旧 category 端点消失,
  2026-07-30),词条刻意保留 —— 库中存在历史行,union 是「库里可能出现什么事件」的清单,
  与同批已发布错误码「保留不删」同一拍板。
- `member.official-portrait.purge` ⇒ **预留**:union 注释补〔预留 · 未接〕
  (#1106 T1 刻意未接;合规清理流程见 issue #1055 §5.2,建流程时接通)。

登记表备注与 NEXT_TASKS P2-23b 同步;审计判据 D6 对「已退役」「零产出」两种标注都认,
18/18 复跑通过。`audit-logs.types.ts` 不在红区,注释级改动零风险。
