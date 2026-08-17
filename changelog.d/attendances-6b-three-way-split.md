### Changed

- `AttendancesService` 按 D-7 边界拆为四个单元(Phase 6-B 第三域第一刀):共享准入 `AttendanceAccessService`(110)、审批八式 `AttendanceReviewService`(623)、读 surface 族 `AttendanceReadService`(298),主 service 由 **1481 → 619 NCLOC** 并**跌破 700 阈值退出尺寸基线**(28 → 27 条)。`AttendancesService` 仍是本模块唯一对外入口,15 个方法保留同名薄委托,三个 controller 与薄壳 service 的调用面逐字不变。零 endpoint / 零 DTO / 零 OpenAPI / 零 BizCode / 零权限码变更。转闸摩擦(SERVICE_SIZE_RATCHET §3 严口径)由 93 降至 **77**。
