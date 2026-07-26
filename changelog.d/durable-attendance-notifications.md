### Fixed

- 将考勤一审/终审退回与终审通过通知接入既有 PostgreSQL durable outbox，使 Sheet 状态、审计和通知 intent 原子提交，并由 worker 在事务外可靠重试。
