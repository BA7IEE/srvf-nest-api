### Added

- 存储不变量原语补齐单测(Phase 6-B 第四域收尾):`attachment-storage-invariants.ts` 的七个函数共 22 例。该层是 attachments 全模块共用的判定底座(`terminalSucceededData` 被 4 个文件引用),迁出编排器前零单测覆盖,一处失效会同时影响上传确认、删除终态化、人工重定位、人工缺失认定四条路径。用例挑的是「容易写错且失效不报错」的行为:Prisma 的 `undefined`(不更新)与 `null`(清空)语义之别、`size: 0` 的合法性、SHA-256 大小写归一化、以及「缺证据」与「内容不符」两类错误的分界。
