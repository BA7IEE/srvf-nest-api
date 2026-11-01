# R5正式容量候选与历史读取边界

将正式贡献活动准入扩为2000身份、10000当前段/最新分配、50000切片和8000评价，并按一次固定输入最大值加25%确定47MiB来源/51MiB评价文档边界；同步生成500和每分配500切片不变。

段重建只取全部当前段及投影键最大历史revision；时长读取改为参数化读取绝对最新分配，保留committed拒绝、无回退、revision递增和锁后hash校验。真实政策发布/worker/完整提交及两类更正按独立验收记录，不改变权限、schema或事务预算。详见docs/plans/activity-os-r5-native-capacity-acceptance.md。
