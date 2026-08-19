/**
 * 从源码里取出某个方法「签名 + 方法体」的整段文本,给结构判据当输入。
 *
 * ⚠️ 天真的「从签名处开始数花括号」是错的:参数表里的**内联对象类型**
 * (`input: Foo & { requestHash: string }`)会先开一对花括号又先闭上,
 * 于是段落在参数表就结束了 —— 判据拿到的是签名而不是方法体,任何
 * `toContain(方法体里的东西)` 都恒假,而 `toContain` 恒假只表现为「这条判据红了」
 * 或者更糟:换成 `not.toContain` 时**恒真**,变成一条永远绿的空判据。
 *
 * 正确做法分两步:先按圆括号配平跳过参数表,再从其后的第一个 `{` 开始按花括号配平。
 */
export function extractMethodSource(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);

  // ① 跳过参数表:从签名里的第一个 '(' 起,数到它配平为止。
  const parenStart = source.indexOf('(', start);
  if (parenStart < 0) throw new Error(`no parameter list for ${signature}`);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd < 0) throw new Error(`unbalanced parameter list for ${signature}`);

  // ② 方法体:参数表之后的第一个 '{' 起,数到它配平为止。
  const bodyStart = source.indexOf('{', parenEnd);
  if (bodyStart < 0) throw new Error(`no method body for ${signature}`);
  let braceDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') braceDepth += 1;
    else if (source[i] === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced method body for ${signature}`);
}
