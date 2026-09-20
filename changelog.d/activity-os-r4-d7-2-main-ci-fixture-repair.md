## D7-2 主干 CI 夹具清理修复

- 为 A3 与 C1 D2b 两处受控 E2E fixture cleanup transaction 显式设置 60 秒上限，避免默认 5 秒 Prisma transaction timeout 在业务断言开始前中断清理。
- 未改测试断言、测试总时限、业务事务预算、测试基础设施、生产代码、schema、migration、接口、权限或 Gate。
