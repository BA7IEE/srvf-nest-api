---
"feat(activities)": AC-047 —— 「活动未结束」补上独立执行位(提交侧 20160;P1-28 9a C 档,todo 9→8)

- `settlement-submit.service`:Activity 锁读补 `endAt`,新提交(非重放)在 run 状态闸前
  判 `now < endAt ⇒ SETTLEMENT_SUBMIT_ACTIVITY_NOT_ENDED(20160)`(判定用应用时钟)
- 填的是「零 live 场次」真空:此前「窗口未关闭 / 无开放段」两道闸在零场次时双双放行,
  活动结束前即可整链提交;封场侧刻意不加闸(零场次早封无害,提交侧闭住真空)
- e2e 三例:真空形态负例 / 「只允许整理草稿」正面一半(同夹具 draft 仍可 generate)/
  endAt 已过正对照;red-first 变异证据:卸闸 ⇒ 两条负例当场红(2 failed),装回 45/45 绿
- 登记表:AC-047 由 TEST_GAP_2026_08_28_ACCEPTANCE_DESTINATIONS 接通(9a 读数 9→8)

BREAKING: 无(闸关期生产零影响;结算链仅新增一条前置拒绝)
