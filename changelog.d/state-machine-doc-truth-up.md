### Fixed

- 订正 `STATE_MACHINE_INVENTORY.md` §10.4 的过期快照:该表自称「机器现算」,实为一次性抄入的数字 —— 复核时登记表已 **58** 条而表里写 56、`governed/inventory` 实况 **8/50** 而表里写 8/48。同时标明三行 `transitions` 分布按**全部条目**而非 inventory 子集统计(两种口径下 `unconstrained` 分别是 13 与 5)。新增机器守护:§10.4「总条目」必须等于 `harness/state-machines.json` 的 `entries` 长度。
