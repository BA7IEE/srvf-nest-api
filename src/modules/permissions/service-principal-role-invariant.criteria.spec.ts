import { selfCheckServicePrincipalRoleInvariantAnalysis } from '../../../scripts/check-service-principal-role-invariant';

describe('Service Principal Role 存量预检口径', () => {
  it('由受保护脚本执行完整分析矩阵', () => {
    expect(selfCheckServicePrincipalRoleInvariantAnalysis()).toEqual([]);
  });
});
