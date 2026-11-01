// A deliberately closed proof, not a general SQL parser. Anything outside this
// metadata-only subset returns false and retains the existing raw SQL finding.
type Token = { kind: 'word' | 'quoted' | 'string' | 'other'; value: string };
const relations = new Set([
  'pg_attribute',
  'pg_attrdef',
  'pg_auth_members',
  'pg_class',
  'pg_constraint',
  'pg_database',
  'pg_depend',
  'pg_enum',
  'pg_index',
  'pg_language',
  'pg_namespace',
  'pg_policy',
  'pg_proc',
  'pg_rewrite',
  'pg_roles',
  'pg_trigger',
  'pg_type',
]);
const functions = new Set([
  'current_database',
  'current_setting',
  'count',
  'coalesce',
  'jsonb_agg',
  'jsonb_build_object',
  'pg_get_userbyid',
  'pg_get_expr',
  'pg_get_constraintdef',
  'pg_get_triggerdef',
  'pg_get_ruledef',
  'pg_get_indexdef',
  'pg_get_function_arguments',
  'encode',
  'sha256',
  'convert_to',
  'pg_has_role',
  'has_any_column_privilege',
  'has_table_privilege',
  'has_schema_privilege',
  'has_column_privilege',
  'has_function_privilege',
]);
const syntaxWithParenthesis = new Set([
  'and',
  'or',
  'not',
  'in',
  'any',
  'all',
  'exists',
  'as',
  'values',
  'from',
  'select',
]);
const terminators = new Set([
  'where',
  'group',
  'order',
  'limit',
  'offset',
  'union',
  'except',
  'intersect',
  'having',
  'on',
  'join',
  'cross',
  'left',
  'right',
  'full',
  'inner',
  'outer',
  ')',
  ';',
]);

function tokenize(sql: string): Token[] | null {
  const out: Token[] = [];
  const pattern =
    /\s+|--[^\n]*(?:\n|$)|\/\*[^]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+|::|->>|->|<>|<=|>=|\|\||[(),.;=*+\-/<>:[\]]/gy;
  let offset = 0;
  while (offset < sql.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(sql);
    if (!match || match.index !== offset) return null;
    offset = pattern.lastIndex;
    const value = match[0];
    if ((value === '/' || value === '*') && sql.slice(match.index, match.index + 2) === '/*')
      return null;
    if (value.startsWith('/*') && value.slice(2, -2).includes('/*')) return null;
    if (/^\s|^--|^\/\*/u.test(value)) continue;
    if (value.startsWith("'")) out.push({ kind: 'string', value });
    else if (value.startsWith('"')) out.push({ kind: 'quoted', value });
    else if (/^[A-Za-z_]/u.test(value)) out.push({ kind: 'word', value: value.toLowerCase() });
    else out.push({ kind: 'other', value });
  }
  return out;
}

export function isReadOnlyCatalogSql(sql: string): boolean {
  const tokens = tokenize(sql);
  if (!tokens?.length) return false;
  const word = (i: number) => (tokens[i]?.kind === 'word' ? tokens[i].value : '');
  const value = (i: number) => tokens[i]?.value ?? '';
  if (!['select', 'with'].includes(word(0))) return false;
  const forbidden = new Set([
    'insert',
    'update',
    'delete',
    'merge',
    'call',
    'do',
    'execute',
    'into',
    'copy',
    'truncate',
    'alter',
    'create',
    'drop',
    'grant',
    'revoke',
    'vacuum',
    'lock',
    'for',
    'recursive',
    'table',
  ]);
  if (tokens.some((token) => token.kind === 'word' && forbidden.has(token.value))) return false;
  if (tokens.some((token, index) => token.value === ';' && index !== tokens.length - 1))
    return false;
  const ends = new Map<number, number>(),
    stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (value(i) === '(') stack.push(i);
    if (value(i) === ')') {
      const start = stack.pop();
      if (start === undefined) return false;
      ends.set(start, i);
    }
  }
  if (stack.length) return false;
  const builtinCasts = new Set([
    'text',
    'jsonb',
    'int',
    'integer',
    'bigint',
    'oid',
    'regclass',
    'regprocedure',
    'regproc',
    'regtype',
    'regcollation',
    'boolean',
    'regnamespace',
  ]);
  for (let i = 0; i < tokens.length; i++) {
    if (
      (tokens[i].kind === 'word' || tokens[i].kind === 'quoted') &&
      tokens[i + 1]?.kind === 'string' &&
      !['then', 'else'].includes(word(i))
    )
      return false;
    if (value(i) !== '::') continue;
    const at = word(i + 1) === 'pg_catalog' && value(i + 2) === '.' ? i + 3 : i + 1;
    if (!builtinCasts.has(word(at)) || value(at + 1) === '.') return false;
  }
  const ctes = new Set<string>();
  const cteScopes: Array<{ start: number; end: number; available: Set<string> }> = [];
  if (word(0) === 'with') {
    let i = 1;
    for (;;) {
      const name = word(i);
      if (
        !name ||
        ctes.has(name) ||
        word(i + 1) !== 'as' ||
        value(i + 2) !== '(' ||
        word(i + 3) !== 'select'
      )
        return false;
      const end = ends.get(i + 2);
      if (end === undefined) return false;
      cteScopes.push({ start: i + 3, end, available: new Set(ctes) });
      ctes.add(name);
      i = end + 1;
      if (value(i) !== ',') {
        if (word(i) !== 'select') return false;
        break;
      }
      i++;
    }
  }
  // Every FROM/JOIN source, including comma joins and nested subqueries, must
  // independently resolve to a catalog relation or one of the closed CTEs.
  for (let i = 0; i < tokens.length; i++) {
    if (!['from', 'join'].includes(word(i))) continue;
    if (
      word(i) === 'from' &&
      word(i - 1) === 'distinct' &&
      (word(i - 2) === 'is' || (word(i - 2) === 'not' && word(i - 3) === 'is'))
    )
      continue;
    let at = i + 1;
    const available =
      cteScopes.find((scope) => scope.start <= i && i < scope.end)?.available ?? ctes;
    for (;;) {
      if (value(at) === '(') {
        if (!['select', 'values'].includes(word(at + 1))) return false;
        const end = ends.get(at);
        if (end === undefined) return false;
        at = end + 1;
      } else if (
        word(at) === 'pg_catalog' &&
        value(at + 1) === '.' &&
        relations.has(word(at + 2)) &&
        value(at + 3) !== '.'
      )
        at += 3;
      else if (available.has(word(at)) && value(at + 1) !== '.') at++;
      else return false;
      if (word(at) === 'as') at++;
      if ((word(at) && !terminators.has(word(at))) || tokens[at]?.kind === 'quoted') {
        at++;
        if (value(at) === '(') {
          const end = ends.get(at);
          if (
            end === undefined ||
            tokens.slice(at + 1, end).some((t) => t.kind !== 'word' && t.value !== ',')
          )
            return false;
          at = end + 1;
        }
      }
      if (value(at) !== ',') {
        // An unconsumed relation suffix must not hide a later comma source.
        // This closed subset deliberately excludes inheritance and sampling.
        if (at < tokens.length && !terminators.has(value(at))) return false;
        break;
      }
      at++;
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === 'quoted' && value(i + 1) === '(') return false;
    if (tokens[i].kind !== 'word' || value(i + 1) !== '(') continue;
    const name = word(i);
    if (value(i - 1) === '.' && word(i - 2) !== 'pg_catalog') return false;
    // An AS alias(column-list) is not a function invocation.
    if ((word(i - 1) === 'as' || syntaxWithParenthesis.has(name)) && value(i - 1) !== '.') continue;
    if (!functions.has(name)) return false;
    if (value(i - 1) === '.' && word(i - 2) !== 'pg_catalog') return false;
  }
  return true;
}
