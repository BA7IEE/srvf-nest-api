# 材料分支 Diff guards

原生作业先执行 git diff --check，返回 2，命中 T27–T36 的 11 个归档文件共 50 行。此提交仅归一化被点名的行末空白和空尾行，并按文件名更新对应目录的 SHA256SUMS。原始日志与原校验值仍可从上一固定提交逐字取回。续审历史结论应使用当时的固定提交。SQL 和脚本的非空白内容保持一致，运行分支未修改。

[原始证据树](https://github.com/BA7IEE/srvf-nest-api/tree/6e7b30e51e9a3ae5416b5efccfe9ce1ea69f7e5f/docs/ops/runtime-acl) · [失败作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44687773919/job/136126210700) · [逐文件位置与前后校验值](material-guard.json)
