### Fixed

- SMS 单次操作现在以一次 settings snapshot 绑定 provider route、验证码内容、实际发送与 SENT/FAILED evidence；新增不暴露配置或 payload 的短生命周期 prepared Effect，并为生日祝福与通知模板提供后续 Outbox 可接线的 prepare API，现有 notifications runtime 行为保持不变。
