# 其他发布后字段的覆盖边界

| 字段或资源 | 后端合同 | 当前 Simple 页面 | T39 |
|---|---|---|---|
| 标题、活动说明 | V7 change-reviews 接受 activityPatch.title、description，目标与原值进入冻结快照 | 发起页面实际生成这两个字段，独立审核可比较每一项 | 两个必填场景均以浏览器、DB、审计断言 |
| 开始、结束时间、主地点 | UpdateAppManagedActivityDto 的 startAt、endAt、location 属于 change-reviews 可接收的字段，仍需服务端业务校验 | 草稿页可显示或编辑部分日程。已发布活动的负责人变更表单仅提供标题和说明；比对器要求其他活动属性等于冻结基线 | 发布后正向页面 NOT_RUN，当前无该字段的完整申请与审核入口 |
| 容量 | activityPatch.capacity 有 DTO 定义 | 当前审核比对器会拒绝文本以外的额外差异 | 真实待审响应在浏览器中加入容量差异，批准按钮禁用。容量实际申请、批准、入库 NOT_RUN |
| 场次、岗位 | ChangeReviewDto 含 sessions 与 positions 的集合 | 这条表单提交空的 create/update/cancel 集合，无已发布场次或岗位的编辑表单 | 发布后正向页面 NOT_RUN |

适用提交为后端 713d3416830d897852929731ff7f9b638038ab7c（activity-publish-review.dto.ts 的 ChangeReviewDto；dto/app/app-managed-activity.dto.ts 的 UpdateAppManagedActivityDto），前端 eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64（simple/published-change.vue、src/api/srvf-activity-publish-review.ts、workbench/publish-review/state.ts）。本结论只针对这个已测入口。
