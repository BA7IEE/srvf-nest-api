// Phase 2 P2-1 App 准入拒绝原因闭集(展示字符串;**不**绑 BizCode;沿 §4.3 铁律 7-8)。
// 三态来源:User.memberId=null / Member.deletedAt!=null / Member.status=INACTIVE。
// USER 软删 / DISABLED 由 JwtStrategy.validate 提前挡,不进闭集。
export type AppAccessReason = 'MEMBER_NOT_LINKED' | 'MEMBER_INACTIVE' | 'MEMBER_DELETED';
