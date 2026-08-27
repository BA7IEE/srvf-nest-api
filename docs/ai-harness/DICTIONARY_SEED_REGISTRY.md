# 字典 seed 登记表(DICTIONARY_SEED_REGISTRY)

> **seed 内置字典的对外登记表** —— P2-23(2026-08-27)交付的「合同 ④ 字典对账」那一半的落点。
> 此前 ④-b 的签字只能锚 `seed-sha256-12`(整份文件的摘要),证明不了「里面有哪些字典项」;
> 本表把那份盲区变成**逐条点名、机器核对**的清单。
>
> **机器核对**(双向集合相等;判据本体在 `scripts/check-dictionary-seed-registry.ts`(红区),薄运行器 `src/modules/dictionaries/seed-dictionary-registry.spec.ts`):
> seed 里真正 upsert 的每个字典 type / item 都必须登记在册(**漏登记 ⇒ 红**);
> 本表登记的每一条都必须真的在 seed 里(**多登记 / 已消失 ⇒ 红**);
> type 与 item 的 label 与 seed **逐字相等**(**漂移 ⇒ 红**)。
> ⇒ 改 seed 的字典(红区文件,本就要令牌)= 同一 PR 必须同步改本表,否则 CI 红。
>
> **来源(seed.ts 的三个 seed 函数)**:`seedV2Dictionaries`(V2_DICT_SEED 平铺字典)/
> `seedActivityTypeHierarchy`(activity_type 二级树:9 父 + 31 子)/ `seedRecruitmentStageDict`(招新进度态)。
>
> **射程与刻意不登记的**:
> - 只登记 **seed 预置** 的字典项;运营在运行时经后台增改的不在此表(那是字典的功能,不是 seed 的事实)。
> - 不登记 sortOrder、activity_type 的父子关系 —— 本表管「存在性与命名」,
>   它们是 seed 内部行为(登记而不核对会烂成第二份真相,见 P2-20 的教训)。
> - 「seed 不预置 items」的字典**必须**显式标注(见 group_function / member_audience_tag)——
>   空表不许静默,否则「提取器漏了一节」和「本来就没有」长得一模一样。

**字典 type(机器核对):28 个 · item(机器核对):242 项**


## node_type — 组织节点类别

| code | label |
|---|---|
| headquarters | 总部 |
| professional-mountain | 山地专业救援队 |
| professional-water | 水域专业救援队 |
| professional-urban | 城市专业救援队 |
| professional-high | 高空专业救援队 |
| rescue-team | 救援保障队 |
| functional-dept | 职能部门 |
| volunteer | 志愿者 |
| group | 组 / 工作组 |

## member_grade — 队员级别

| code | label |
|---|---|
| volunteer | 志愿者 |
| level-1 | 正式队员1级 |
| level-2 | 正式队员2级 |
| level-3 | 正式队员3级 |
| level-4 | 正式队员4级 |
| level-5 | 正式队员5级 |
| level-6 | 正式队员6级 |
| level-7 | 正式队员7级 |
| reserve | 后备队员 |

## emergency_relation — 紧急联系人关系

| code | label |
|---|---|
| family | 家人 |
| friend | 朋友 |
| spouse | 配偶 |
| parent | 父母 |
| child | 子女 |
| other | 其他 |

## gender — 性别

| code | label |
|---|---|
| male | 男 |
| female | 女 |
| unknown | 未知的性别 |
| unspecified | 未说明的性别 |

## document_type — 证件类型

| code | label |
|---|---|
| id_card | 居民身份证 |
| household_register | 居民户口簿 |
| passport | 护照 |
| military_id | 军官证 / 士兵证 |
| hk_macau_permit | 港澳居民来往内地通行证 |
| taiwan_permit | 台湾居民来往大陆通行证 |
| foreigner_permit | 外国人永久居留身份证 |
| other | 其他 |

## political_status — 政治面貌

| code | label |
|---|---|
| ccp_member | 中共党员 |
| ccp_probationary_member | 中共预备党员 |
| cyl_member | 共青团员 |
| rcck_member | 民革党员 |
| cdl_member | 民盟盟员 |
| cndca_member | 民建会员 |
| cape_member | 民进会员 |
| cpwdp_member | 农工党党员 |
| cpp_member | 致公党党员 |
| js_member | 九三学社社员 |
| tdsl_member | 台盟盟员 |
| non_party | 无党派人士 |
| masses | 群众 |

## blood_type — 血型

| code | label |
|---|---|
| a | A 型 |
| b | B 型 |
| ab | AB 型 |
| o | O 型 |
| unknown | 未知 |

## work_nature — Demo work nature

| code | label |
|---|---|
| demo-work-1 | Demo work 1 |
| demo-work-2 | Demo work 2 |
| demo-work-3 | Demo work 3 |
| demo-work-4 | Demo work 4 |

## cert_type — 证书大类

| code | label |
|---|---|
| first_aid | 救护员 |
| bsafe | BSAFE |
| outdoor | 户外 |
| coach | 教练 |
| comm | 通讯 |
| medical | 医疗 |
| other | 其他 |

## cert_sub_type — 证书等级 / 子类型

| code | label |
|---|---|
| bsafe_l1 | BSAFE 一级 |
| bsafe_l2 | BSAFE 二级 |
| first_aid_basic | 救护员基础 |
| first_aid_advanced | 救护员高级 |
| amateur_radio_a | 业余无线电 A 类 |
| amateur_radio_b | 业余无线电 B 类 |
| amateur_radio_c | 业余无线电 C 类 |

## cert_status — 核验状态

| code | label |
|---|---|
| pending | 待核验 |
| verified | 已核验 |
| expired | 已失效 |
| rejected | 拒绝 |

## activity_status — 活动状态

| code | label |
|---|---|
| draft | 草稿 |
| published | 已发布 |
| cancelled | 已取消 |
| completed | 已完成 |

## registration_status — 报名状态

| code | label |
|---|---|
| pending | 待审核 |
| pass | 已通过 |
| reject | 未通过 |
| cancelled | 已取消 |
| waitlisted | 候补中 |

## attendance_sheet_status — 考勤单据状态

| code | label |
|---|---|
| pending | 待 APD 审核 |
| pending_final_review | APD 已审,待终审 |
| approved | 终审通过 |
| rejected | APD 驳回 |
| final_rejected | 终审驳回 |

## attendance_status — 考勤明细状态

| code | label |
|---|---|
| present | 已到场 |
| late | 迟到 |
| early_leave | 早退 |

## attendance_role — 考勤角色

| code | label |
|---|---|
| member | 队员 |
| instructor | 讲师 |
| assistant | 助教 |
| coach | 教练 |
| front_command | 前指 |
| back_command | 后指 |
| info | 信息 |

## content_type — 内容类型

| code | label |
|---|---|
| announcement | 公告 |
| publicity | 公示 |
| briefing | 简报 |
| post | 推文 |

## marital_status — 婚姻状况

| code | label |
|---|---|
| unmarried | 未婚 |
| married | 已婚 |
| widowed | 丧偶 |
| divorced | 离婚 |
| unspecified | 未说明的婚姻状况 |

## education — 学历 / 文化程度

| code | label |
|---|---|
| doctor | 博士研究生 |
| master | 硕士研究生 |
| bachelor | 大学本科 |
| college | 大学专科 |
| secondary_vocational | 中等职业教育 |
| senior_high | 普通高中 |
| junior_high | 初中 |
| primary | 小学 |
| other | 其他 / 未说明 |

## ethnicity — 民族

| code | label |
|---|---|
| han | 汉族 |
| mongol | 蒙古族 |
| hui | 回族 |
| zang | 藏族 |
| uygur | 维吾尔族 |
| miao | 苗族 |
| yi | 彝族 |
| zhuang | 壮族 |
| buyei | 布依族 |
| chosen | 朝鲜族 |
| man | 满族 |
| dong | 侗族 |
| yao | 瑶族 |
| bai | 白族 |
| tujia | 土家族 |
| hani | 哈尼族 |
| kazak | 哈萨克族 |
| dai | 傣族 |
| li | 黎族 |
| lisu | 傈僳族 |
| va | 佤族 |
| she | 畲族 |
| gaoshan | 高山族 |
| lahu | 拉祜族 |
| sui | 水族 |
| dongxiang | 东乡族 |
| naxi | 纳西族 |
| jingpo | 景颇族 |
| kirgiz | 柯尔克孜族 |
| tu | 土族 |
| daur | 达斡尔族 |
| mulao | 仫佬族 |
| qiang | 羌族 |
| blang | 布朗族 |
| salar | 撒拉族 |
| maonan | 毛南族 |
| gelao | 仡佬族 |
| xibe | 锡伯族 |
| achang | 阿昌族 |
| pumi | 普米族 |
| tajik | 塔吉克族 |
| nu | 怒族 |
| uzbek | 乌孜别克族 |
| russ | 俄罗斯族 |
| ewenki | 鄂温克族 |
| deang | 德昂族 |
| bonan | 保安族 |
| yugur | 裕固族 |
| gin | 京族 |
| tatar | 塔塔尔族 |
| derung | 独龙族 |
| oroqen | 鄂伦春族 |
| hezhen | 赫哲族 |
| monba | 门巴族 |
| lhoba | 珞巴族 |
| jino | 基诺族 |

## join_source — 加入来源

| code | label |
|---|---|
| recruitment | 招新转入 |
| manual | 管理员录入 |
| import | 历史录入 |

## notification_type — 通知类型

| code | label |
|---|---|
| activity-reminder | 活动提醒 |
| recruitment | 招新公告 |
| emergency | 紧急召集 |
| general | 一般通知 |
| expiry-reminder | 到期提醒 |
| activity-published | 活动发布 |
| activity-changed | 活动变更 |
| registration-result | 报名结果 |
| attendance-result | 考勤结果 |

## org_establishment_status — 组织设立状态

| code | label |
|---|---|
| formal | 正式 |
| provisional | 筹备 |

## group_function — 组功能

> seed 不预置 items(运营自填;依据见 seed.ts 该条目注释)。

## gender_requirement — 活动性别要求

| code | label |
|---|---|
| any | 不限 |
| male | 仅男 |
| female | 仅女 |

## member_audience_tag — 会员受众标签

> seed 不预置 items(运营自填;依据见 seed.ts 该条目注释)。

## activity_type — 活动类型

| code | label |
|---|---|
| rescue | 救援 |
| support | 保障 |
| outreach | 外展活动 |
| training | 训练 |
| exchange | 交流 |
| joint_drill | 联合演练 |
| duty_rotation | 轮值 |
| logistics | 物资 |
| other | 其他 |
| rescue_mission | 救援 |
| disaster_relief | 救灾 |
| assistance | 救助 |
| assembled_no_action | 集结未行动 |
| event_support | 赛事保障 |
| team_activity_support | 队伍活动保障 |
| external_lecture | 对外讲座 |
| external_promotion_federation | 对外宣导(联合会) |
| external_training | 对外培训 |
| external_promotion_department | 对外宣导(部门) |
| team_training | 队伍训练 |
| external_course | 外部培训 |
| no_contribution_training | 无贡献值训练 |
| competition_exchange | 赛事比武交流 |
| key_meeting | 重要会议 |
| external_joint_drill | 外单位联合演练 |
| internal_multi_dept_drill | 内部三个部门以上联合演练 |
| futian_ustation | 福田 u 站 |
| wutongshan_duty | 梧桐山轮值 |
| icc_duty | ICC轮值、无人机小组轮值 |
| helicopter_duty | 直升机轮值 |
| department_duty | 部门轮值 |
| daily_supplies | 日常物资 |
| event_support_supplies | 赛事保障物资 |
| rescue_relief_supplies | 救援救灾物资 |
| interview | 采访 |
| general_meeting | 一般会议 |
| psychological_assessment | 心理评估 |
| department_team_building | 部门团建 |
| transportation | 交通类 |
| special_social_service | 特殊社会服务 |

## recruitment_stage — 招新进度态

| code | label |
|---|---|
| manual | 待人工核验 |
| threshold | 门槛未完成 |
| threshold_done | 门槛已完成 |
| evaluation | 待综合评定 |
| publicity | 公示中 |
| volunteer | 已转志愿者 / 待入队 |
| rejected | 未通过 |
| retake | 待重拍 |
| confirm | 待核对 |
| manual_high | 待人工核验 |
| withdrawn | 已撤销报名 |
