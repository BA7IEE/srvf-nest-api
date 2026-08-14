### Added

- 架构治理:`harness-guards.selftest.ts` 新增一条**结构断言**,钉住 `ActivityRegistrationsService.cancelMy` 的**两道**属主判定(`X.memberId !== memberId` 且所在 `if` 的 then 分支会抛)。判据要的是**后果**不是比较本身 —— 裸比较不算守卫,与「调用无后果分支不构成断言」同一条哲学。

- **为什么是结构断言而不是 e2e**:`cancelMy` 的两道判定(锁活动前一道、锁后复读再一道)是纵深防御,删掉任意**一道**另一道照样返 404,**可观测行为逐字不变**,黑盒测试原理上区分不了「一道」与「两道」。实测印证:单删任一道 `app-my-registrations-write` 42 条全绿,两道全删才红 2 条。这一处正是 e2e 够不到、而「删一行无人知」真实成立的地方。

- 其余三条内存比对属主的端点(`GET my/registrations/:id`、`GET notifications/:id`、`POST notifications/:id/read`)各只有一道判定,删掉即有具名 e2e 用例转红(`app-my-registrations-read:508`、`notifications-directed:171`),**已由行为层锁住,不重复登记**。

- 判据由变异对拍绑定:删第一道 / 删第二道 / 保留比较但去掉 `throw` —— **三种变异各自翻红**;`findMy` 的单道判定作为**正对照**恒为 1,全程未被误伤(防判据写坏成恒 0 或恒大而无人发现)。
