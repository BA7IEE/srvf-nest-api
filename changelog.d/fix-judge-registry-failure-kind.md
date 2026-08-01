- **裁判注册表失败分档修正(R1 真触发发现;2026-08-01)**:R1 落地的「四元组冻结」把
  「换载体」判成硬失败是对的,但 `main()` 里挑分支写成了
  `if (!registryVerdict.ok) failHard('棘轮注册表被削减' …)` —— 而 `ok` 在 `removed`
  **或** `mutated` 任一非空时都为 false。于是**换载体**的失败一头撞进「被削减」那条分支,
  `process.exit(1)` 之后「换了载体」那条根本到不了。

  一次性对抗 PR [#870](https://github.com/BA7IEE/srvf-nest-api/pull/870)(同 id 换 baseline
  载体,v2 为原基线逐字节副本)实测:`Red-zone trusted scan` **fail** ✓、
  `Red-zone trusted approval` **skipping** ✓ —— **门是关住的,fail-closed 没错**;
  但打印出来的是 `✗ 棘轮注册表被削减:登记只可增不可删` + **`head 少了 0 条:`**,
  一句自相矛盾的话。operator 会按错误的原因去排查,而「守护说的话和它实际判的事不是
  一回事」正是本仓反复抓的那一类(注释≠执行位的同族,这是第 N 次)。

  **修法**:把「该报哪一种失败」从 if 链抽成纯函数 `registryFailureKind(verdict)`
  (`removed` / `mutated` / `null`;removed 优先 —— 条目都没了就谈不上载体换没换),
  `main()` 改判它的返回值。

  **为什么原来的自测抓不到**:那组断言判的是 `judgeRegistryMonotonicity` 的**返回值**,
  而返回值一直是对的(`mutated` 数组该有的都有);错的是 `main()` 里拿返回值**挑分支**
  的那几行 —— 纯函数对照与结构断言都碰不到接线。抽成纯函数之后,分支选择本身有了
  阳性对照(5 条,含关键的「只有 mutated 的裁决不许返回 `removed`」)。

  **前后对照**(同一组 verdict 喂两种分支写法):「只有 mutated」修复前报 `removed` ❌、
  修复后报 `mutated` ✅;其余 4 条前后一致(不误伤)。

  **这次真触发的价值不在于确认门关住了**,而在于它证明了「结构断言 + 纯函数对照」
  看不见 `main()` 的接线 —— [#868](https://github.com/BA7IEE/srvf-nest-api/pull/868)
  当时把 R1 记为「只有结构断言,缺 run 链接」是对的,但缺的不只是一条链接。
