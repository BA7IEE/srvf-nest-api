# T58 复核口径

所有远程采样使用已固定的 SSH 别名，BatchMode=yes、StrictHostKeyChecking=yes，宿主公钥指纹与此前记录相同。时间统一按 UTC 采集，报告展示的北京时间为 UTC+8。服务器无需放置采集脚本。样本按读取时间分组，不是一个跨容器、数据库、journal 的原子快照。

| 目的 | 执行的只读命令或查询 | 回执 |
|---|---|---|
| 版本及制品 | GitHub `pulls/{n}`、`commits/main`、合并和受审 Git tree、hooks 数量、精确 SHA 的 workflow run 与 artifact 元信息；Admin 另比较受审 head 到 merge 的文件差额 | 三仓成功；字段见 github.json |
| 实际执行身份 | `docker inspect --format` 分别投影 Id、Image、StartedAt、标签、网络、挂载和服务名；`docker image inspect --format` 投影 RepoDigests、OCI revision；`docker top … -eo pid,comm`、目标 PID 1 入口分类、关键模块逐文件 SHA256、`docker diff` 仅统计应用路径 | 运行卷只挂在 /runtime；普通 API 的 dist 层变化计数 0。最初遇无 Health 键后改用可选键，最终取证 exit 0 |
| 虚拟主机 | 定向打开 dp conf 并只投影路由指令；核 nginx worker 启动与主机挂载。对 127.0.0.1 使用 `curl --resolve dp.srvf.team:443:127.0.0.1`，保留证书校验；记录静态响应字节哈希或健康状态码。未登陆、未调用写接口 | 合同 live/ready 200，curl exit 0；首次路径错误返回 404，亦留档 |
| 主机调度 | 获取 cron 文件与被引用脚本的触发时刻/指令分类；`systemctl list-unit-files` 和 `systemctl show` 核 enabled/active/trigger；查询有用户总线的用户单元。本窗口 journal 限量读取单位元数据、cron 命令和 agent 部署指示计数，输出中没有日志正文 | 最初 journal 通配查询 124；改用全窗口元数据 2,976 条，成功且未截断。Docker events 数值受环形缓冲限制 |
| 面板调度 | 对在用 agent/core、旧 1Panel、task 与 xpack 的指定 SQLite 库用 URI mode=ro。只读表结构、任务类型/状态/数量、开始时间、脚本行为匹配计数。排程与 webhook 候选检索包含停用项 | agent/旧库均 0 个任务和运行记录；没有读取会话库、secret 列、脚本原文或远端请求头到回执 |
| 数据库 | 复用 PG 容器本机连接，`psql -XAtqw -v ON_ERROR_STOP=1`；每次显式 BEGIN READ ONLY、短 statement_timeout、ROLLBACK。按 pg_stat_activity 观察角色/客户端类别，不查 query；目录查询 has_column_privilege、has_*_privilege、pg_policy、函数签名/归属和 prosrc 摘要；队列只输出计数与完成时间 | 各查询 exit 0，样本给出 transaction_read_only=on。将成功迁移名/checksum 与每个固定 Git 提交的 SQL 原字节独立比较，156/156 对齐 |
| 证据复核 | 在材料分支验证 t55/t57/t58 的 SHA256SUMS、git diff --check、新文档链接与 JSON；保留此前证书的历史提交 | 当前 PR 同步 main 时唯一冲突是 t49/preflight.sql，保留已合并正式版本中的 CONNECT 与 schema USAGE 检查；仅修复两份旧 Markdown 行尾空白并更新其清单 |
