### Added

- 生成的前端 client 产物(`docs/handoff/clients/**` 共 11 份)头部新增 **`// contractVersion: x.y.z`**。引入 client 的仓库在自己那边 `grep -r contractVersion` 即可答出「我编译在哪一版契约上」,不需要后端配合、不需要后端已部署。该值**派生自** `docs/handoff/openapi.json` 的 `info.version`,**不是新增第四处版本声明**(真源恒为三处);且 `info.version` 本就在 `inputDigest` 的输入闭包里 ⇒ 改了版本而不重新生成,`pnpm docs:feclient:check` 当场逐字对不上,**戳与真源脱节在结构上不可能**。快照缺 `info.version` 时生成器直接抛错,拒绝印出 `contractVersion: undefined`。
- 新增 **`docs/handoff/contract-version-registry.md`** —— 合同 §16.1 第 ⑤ 条「五端同一 contract version」的**回执落点**。表内只用哨兵值(`未回执` / `同后端`)与各端实际回执版本,**不写后端版本号**,避免登记表自己变成会静默过期的第四处声明。

### Changed

- `pnpm cutover:check` 的 **5b** 从一句「本仓看不见」改成**对登记表的计算读数**:点名版本对不上的端、列出从未回执的端、并给出可执行的取证指引。登记表缺失 / 被清空 / 少了合同点名的某一端时当场说破(空表恒「零不一致」是空绿)。**5b 仍恒为「⏸ 待维护者确认」** —— 它的证据必须来自别的仓库,本仓不可能使其变绿;这一点由结构保证:`eviSub()` 硬编码 `pending`,`renderVerdict()` 只在 A 类才可能渲染成 ✅。
- `pnpm cutover:check` 的 **5a** 从「比对三处真源」扩为「三处一致 **且全仓无第四处硬编码**」:扫描 `src` / `scripts` 下全部 `.ts`,报出白名单之外任何等于当前 contract version 的字符串字面量。此前「不新增第四处版本声明」只是自律 —— 5a 只读那三处点名位置,**第四处声明在任何别处都看不见**,而它不会被 `release:prepare` 同步、发版后静默过期。按「值等于当前版本」而非「形如 semver」扫描,以免把仓内别的版本命名空间(generator / schema 版本)全网进来把判据淹成摆设。
