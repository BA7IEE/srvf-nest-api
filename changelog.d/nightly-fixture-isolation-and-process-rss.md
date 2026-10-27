### Fixed

- E3 mapping proof 在普通 worker 中先复用完整业务夹具清理，避免继承前一套件的贡献政策选择；公共清理保护和原触发器状态断言不变。
- Linux 草稿资源探针使用当前可执行进程的 VmHWM，避免 getrusage 峰值携带父进程历史内存；原 512 MiB、30 秒及业务结果断言不变。
