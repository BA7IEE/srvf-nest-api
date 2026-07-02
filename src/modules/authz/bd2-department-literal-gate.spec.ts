import * as fs from 'node:fs';
import * as path from 'node:path';

// 终态 scoped-authz PR9(2026-07-02;goal 决断④;冻结稿 §2.4 BD-2):「无部门字面量门控」CI 断言。
//
// BD-2 纪律:终审(及未来任何 scoped 判权)身份只认 RoleBinding 配置行,**代码里绝不出现
// 'APD' / 具体部门字面量的判权门控**(如 `if (dept === 'APD')`)。本 spec 把该纪律变成机器闸:
// 对 src/modules/authz/** + src/modules/attendances/** 的 .ts 生产源码,剥离注释后断言不含 'APD'。
//
// 口径(goal 前提校正,亲核 2026-07-02):goal 原文假设 src 内 'APD' 仅存在于 authz/CLAUDE.md
// 禁令文本,实测 attendances 模块另有两类合法存量 —— 据此收敛检查面而不是改历史文本:
// 1. **注释**(业务史称谓「APD 一级审」等):非代码,剥离后不参与断言;
// 2. **OpenAPI 文档文案层**(下方 allowlist 3 文件):'APD' 只出现在 @ApiOperation summary /
//    @ApiProperty description 的人读字符串里,属 contract-locked 契约文本(改动即破 openapi
//    snapshot,api-surface-policy §8),且不是判权逻辑 —— 显式豁免并锁在 allowlist,新增文件不豁免。
// *.spec.ts 同理豁免(测试标题/fixture 是描述,不是门控;生产判权路径不在其中)。
//
// 若未来任何人把 'APD'(或任何部门 code)写进这两个模块的可执行逻辑 —— 字符串比较、switch、
// seed 常量 —— 本 spec 立即红,失败信息直接指出文件与行。

const MODULE_DIRS: ReadonlyArray<{ label: string; dir: string }> = [
  { label: 'src/modules/authz', dir: path.resolve(__dirname) },
  { label: 'src/modules/attendances', dir: path.resolve(__dirname, '../attendances') },
];

// OpenAPI 文档文案层豁免(仅此 3 个存量文件;相对各自模块根):理由见文件头第 2 条。
const OPENAPI_DOC_TEXT_ALLOWLIST: ReadonlySet<string> = new Set([
  path.join('src/modules/attendances', 'attendances.controller.ts'),
  path.join('src/modules/attendances', 'attendances.dto.ts'),
  path.join('src/modules/attendances', 'dto', 'app', 'app-my-attendance-record.dto.ts'),
]);

function listTsFilesRecursively(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursively(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

// 剥离注释:先块注释(/* … */,含 JSDoc),后行注释(// …)。近似词法(不解析字符串内的
// 注释符),对本仓风格足够;若误伤导致漏报,兜底仍有 e2e 行为锁;误报(把注释当代码)不会发生。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('BD-2 无部门字面量门控(PR9 决断④ CI 断言)', () => {
  it("authz + attendances 生产 .ts 剥离注释后不含 'APD'(OpenAPI 文案层 3 文件显式豁免)", () => {
    const violations: string[] = [];
    for (const { label, dir } of MODULE_DIRS) {
      for (const file of listTsFilesRecursively(dir)) {
        const rel = path.join(label, path.relative(dir, file));
        if (OPENAPI_DOC_TEXT_ALLOWLIST.has(rel)) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        if (!code.includes('APD')) continue;
        const offendingLines = code
          .split('\n')
          .map((line, i) => ({ line, no: i + 1 }))
          .filter(({ line }) => line.includes('APD'))
          .map(({ line, no }) => `  ${rel}:${no}(剥注释后)→ ${line.trim()}`);
        violations.push(...offendingLines);
      }
    }
    // 失败输出即违规行清单(文件:行 → 剥注释后内容)
    expect(violations).toEqual([]);
  });

  it('豁免清单未悄悄扩张,且 3 个豁免文件真实存在(防拼写漂移让豁免落空)', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    for (const rel of OPENAPI_DOC_TEXT_ALLOWLIST) {
      expect({ rel, exists: fs.existsSync(path.join(repoRoot, rel)) }).toEqual({
        rel,
        exists: true,
      });
    }
    expect(OPENAPI_DOC_TEXT_ALLOWLIST.size).toBe(3);
  });
});
