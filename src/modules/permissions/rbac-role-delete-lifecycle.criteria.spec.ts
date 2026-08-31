import {
  APPROVED_ENTRY,
  CONTROL_VALID_SOURCE,
  EXPECTED_APPROVED_DELETE_WRITES,
  MIN_SCANNED_PRODUCTION_FILES,
  MUTATION_CASES,
  analyzeRepository,
  analyzeSource,
  selfCheck,
} from '../../../scripts/check-rbac-role-delete-lifecycle';

// C2.2：薄运行器。扫描、顺序判定、扫描面地板与变异样本全部留在受保护的 scripts/check-*.ts。
describe('rbac role delete lifecycle guard', () => {
  const report = analyzeRepository();

  it('self-proves its scan surface, anchors and approved write count', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.scannedFiles.length).toBeGreaterThanOrEqual(MIN_SCANNED_PRODUCTION_FILES);
    expect(report.approvedDeleteWrites).toHaveLength(EXPECTED_APPROVED_DELETE_WRITES);
  });

  it('passes the valid lifecycle control', () => {
    expect(analyzeSource(APPROVED_ENTRY.file, CONTROL_VALID_SOURCE)).toEqual([]);
  });

  it.each(MUTATION_CASES)('$label', ({ file, source, expectedRule }) => {
    expect(analyzeSource(file, source).map((item) => item.rule)).toContain(expectedRule);
  });

  it('keeps all production role delete writes inside the approved lifecycle protocol', () => {
    expect(report.violations).toEqual([]);
  });
});
