### 字典 seed 登记表 + 双向对拍判据 —— 合同 ④「字典对账」那一半从零执行位到机器核对

P2-23a(2026-08-27)。合同 ④ 要求「字典…生成并对账」,而机器侧此前只有 `seed-sha256-12`
(整份 seed 的摘要)—— 它证明「你签字时看的那份 seed 还是这一份」,证明不了**里面有哪些字典项**;
新增 / 删除一个字典项不会让任何读数动一下。本刀交付两件:

- `docs/ai-harness/DICTIONARY_SEED_REGISTRY.md`:seed 内置字典 **28 type / 242 item** 逐条点名
  (AST 提取生成后人工复核,非手抄);两个 seed 刻意不预置 items 的字典
  (group_function / member_audience_tag)显式标注「seed 不预置」,空表不许静默。
- `src/modules/dictionaries/seed-dictionary-registry.spec.ts`(unit 轮,不连库):AST 读
  `prisma/seed.ts`,七维判决(D0 仪器健康 / D1 upsert 站点闭集 / D2 声明行对拍 / D3 漏登记 /
  D4 多登记 / D5 label 逐字镜像 / D6 空表标注)各自成 it;常驻变异对拍 M1–M6 红集精确、
  两两不相交。join_source 族的 4 个常量引用走活 import 绑定表,闭集外标识符 fail-closed 红。

⇒ 此后改 seed 的字典(红区文件,本就要令牌)= 同一 PR 必须同步改登记表,否则 CI 红。
Audit events 那一半(合同 ④ 的另一半)原样未动,见 `NEXT_TASKS.md` P2-23。
