### Changed

- `ActivitiesService` 按 D-7 边界拆为五个单元(Phase 6-B 第三域第三刀):序列化层 `activity-presenter.ts`(83,**模块级纯函数**)、共享准入与校验 `ActivityAccessService`(304)、建单改单 `ActivityWriteService`(483)、状态流转 `ActivityStatusCommandService`(362),主 service 由 **1263 → 201 NCLOC**。主 service 仍是唯一对外入口,九个方法保留同名薄委托;`ActivityFullRow` / `PUBLISHED_ACTIVITY_DISPLAY_FIELDS` 在主 service re-export,既有消费者调用面与类型面逐字不变。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。
