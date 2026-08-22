### Harness / 执法层

- 🔴 **开工门禁的 Bash 旁路收口(P1-31)**:`preflight-required.sh` 此前只挂在 `Edit|Write|MultiEdit|NotebookEdit` 上,**Bash 侧从不校验开工门禁通行标记** ⇒ 一条 `python3 <<'PY' … PY` 写文件完全绕过「依赖 / Prisma 生成物陈旧、落后 `origin/main`、会话中途换分支」这些前提。**同一个写操作走 Edit 被拦、走 Bash 放行** —— 判定不一致本身就是缺陷,而 bypass 模式恰恰要求优先用 Bash,所以这条旁路是**默认路径**不是边角。

  修法:在 `bash-write-guard.sh` 判出写侧之后、查红区之前,增查门禁标记。**次序与 Edit 侧一致**(先门禁后红区)—— 门禁不过时红区结论本身也不可信(可能落后 main、令牌是别的分支留下的)。

  ⭐ **复用而非复制**:直接调用 `preflight-required.sh` 本体(喂一个不含 `file_path` 的 JSON,它会落到标记校验那一段),**零份重复判定**。复制一份的话两份对「什么算门禁过」的理解会各自漂移,而漂移时「一侧放行一侧拦」**没有任何症状** —— 那正是本条缺陷自己的形态。

  ⭐ **写侧动词表做成单一来源**(`has_write_verb()`):红区判定与门禁预检共用同一个函数。两处各写一份 `case` 模式的话,漂移时会出现「门禁那侧认为不是写、红区这侧认为是写」,门禁被静默跳过。

  **只对写侧生效**:只读命令(`cat` / `grep` / `git log` …)照旧放行 —— 门禁自己的文案就是「只读调研可继续,写操作会被拦下」,Bash 侧同口径。

  ⚠️ **不改 `.claude/settings.json`**:`bash-write-guard.sh` 本就挂在 Bash matcher 上,扩它即可,因而避开了 `settings.json` 与 `settings.example.json` 必须逐字节同步那条自测守护。

  ⚠️ **不覆盖既有已知缺口** `WRITE-GUARD-LITERAL-ONLY`(路径拼接构造就看不见)——那是另一件事,仍是已知缺口。

  hook 自测新增 **10 条**断言(56 → 66),含**一致性对照**(同一写操作在门禁未过 / 已过两种状态下,Edit 侧与 Bash 侧结论必须相同)。⚠️ 同时修了既有 bash 用例的前提:本自测**刻意隔离 preflight marker**,收口后那批测红区行为的用例会集体以「门禁未过」假红(实测 7 条),故为它们装回一份有效 marker 并写明语义边界。
