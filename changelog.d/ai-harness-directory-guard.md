### docs/ai-harness 目录登记守护 + 零产出事件考古定位

#1202 自述暴露的缺口:「少登记一条目录**不产生任何坏链接**,只能靠人眼或专门的守护发现」。
本刀补上那个守护,并把 #1203 登记的 3 个零产出审计事件的成因用 git 考古钉死:

- `src/ai-harness-docs-directory.spec.ts`(unit 轮,零红区):README 目录表 ↔
  `docs/ai-harness/*.md` **双向集合相等** —— 死链红(D1)、漏登红(D2),
  带路径的链接不算本表职责(不误报);含合成变异对拍 M1–M4。现状 21 文件 ↔ 21 链接,干净。
- `AUDIT_EVENT_REGISTRY.md` 三个零产出备注从「疑似已退役」升级为带出处的结论:
  `recruitment-application.certificate-upload` / `.certificate-review` 生产者随
  #830(PR-4a-2,2026-07-30 删旧 category 端点)消失,词条保留但漏标注;
  `member.official-portrait.purge` 是 #1106(T1)刻意预留,合规清理流程未建。
  处置(补〔已退役〕标注 / 删词条 / 接通 purge)待维护者拍板。

⚠️ 过程仪器教训(TOOL_TRAPS 同款):首轮 diff 报「3 个死链」,复核发现是
README 对三个生成物各链两次而 diff 未去重 + 旧临时文件串场 —— `comm + sort -u` 复核为
双向零差。已按「先验仪器再下结论」处理,未把假读数写进任何交付物。
