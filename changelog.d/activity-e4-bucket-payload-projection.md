减少prepare的C3 bucket写入重复参数：bucket语句只传bucket字段，source语句只传同批ID及sources；SQL、写入顺序、数量校验、锁、权限、触发器和原30秒预算不变。修复仅减小JSON传输/解析工作，不代表E4满额超时根因或正式验收已通过。
