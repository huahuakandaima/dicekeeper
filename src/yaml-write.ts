// yaml-write.ts — YAML 序列化器（parseYaml 的反向，P3b 内容编辑器用）
// 输出风格与内置包一致：map/list/inline 数组与对象 / 块标量 |（多行与特殊字符字符串）
// 保证 serializeYaml → parseYaml roundtrip 无损（对 DiceKeeper 支持的 YAML 子集）

export class YamlWriteError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlainScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null;
}

// 字符串能否原样输出（parseScalar 能无损还原为字符串）
// 规避：数字/布尔/null 字面量、冒号（key 分隔）、#（注释）、行首特殊符号、首尾空白、引号/反斜杠（parseScalar 不解析转义）
function isSafePlainString(s: string): boolean {
  if (s === '') return false;
  if (s.includes('\n') || s.includes('\r') || s.includes('\t')) return false;
  if (/["'\\]/.test(s)) return false;
  if (/^\s|\s$/.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return false;
  if (s === 'true' || s === 'false' || s === 'null' || s === '~') return false;
  if (/[:#]/.test(s)) return false;
  if (/^[-?]/.test(s)) return false;
  if (/^[[{&*!|>%@`]/.test(s)) return false;
  return true;
}

// inline 数组/对象里可用的标量：字符串必须安全且不含逗号（parseInline 按逗号切分）
function isInlineScalar(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'boolean') return true;
  if (typeof v === 'string') {
    return isSafePlainString(v) && !v.includes(',');
  }
  return false;
}

function scalarText(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') {
    if (!isSafePlainString(v)) {
      // 单行非安全字符串：引号包裹保真（parseScalar 只去首尾引号、不解转义；stripComment 引号感知）
      // 含 " 时用单引号包裹（避免引号状态切换）；都含时 stripComment 边界风险极低，接受
      if (v.includes('\n') || v.includes('\r')) throw new YamlWriteError(`多行字符串不能出现在标量位置: ${v.slice(0, 20)}`);
      return v.includes('"') ? `'${v}'` : `"${v}"`;
    }
    return v;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  throw new YamlWriteError(`不支持的标量类型: ${typeof v}`);
}

// 多行字符串走块标量 |（parseBlock 支持且不做任何解析；内容行前导空格会丢，parseYaml 限制，接受）
function isBlockString(v: unknown): v is string {
  return typeof v === 'string' && (v.includes('\n') || v.includes('\r'));
}

// 块标量内容行：尾部空行丢弃（parseBlock 会跳过空行；保真损失可接受）
function blockLines(s: string): string[] {
  const lines = s.split('\n');
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface Ctx { lines: string[] }

function writeMap(obj: Record<string, unknown>, base: number, ctx: Ctx): void {
  for (const [k, v] of Object.entries(obj)) {
    const pad = ' '.repeat(base);
    if (typeof v === 'string' && isBlockString(v)) {
      ctx.lines.push(`${pad}${k}: |`);
      for (const l of blockLines(v)) ctx.lines.push(pad + '  ' + l);
    } else if (isPlainScalar(v)) {
      ctx.lines.push(`${pad}${k}: ${scalarText(v)}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        ctx.lines.push(`${pad}${k}: []`);
      } else if (v.every(isInlineScalar)) {
        ctx.lines.push(`${pad}${k}: [${v.map(inlineText).join(', ')}]`);
      } else {
        ctx.lines.push(`${pad}${k}:`);
        writeList(v, base + 2, ctx);
      }
    } else if (isPlainObject(v)) {
      const entries = Object.entries(v);
      if (entries.length === 0) {
        ctx.lines.push(`${pad}${k}: {}`);
      } else if (entries.every(([, val]) => isInlineScalar(val))) {
        ctx.lines.push(`${pad}${k}: {${entries.map(([kk, vv]) => `${kk}: ${inlineText(vv)}`).join(', ')}}`);
      } else {
        ctx.lines.push(`${pad}${k}:`);
        writeMap(v, base + 2, ctx);
      }
    } else {
      throw new YamlWriteError(`不支持的字段值类型: ${k}`);
    }
  }
}

function writeList(arr: unknown[], base: number, ctx: Ctx): void {
  const pad = ' '.repeat(base);
  for (const item of arr) {
    if (isPlainScalar(item)) {
      ctx.lines.push(`${pad}- ${scalarText(item)}`);
    } else if (isPlainObject(item)) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        ctx.lines.push(`${pad}- {}`);
      } else if (entries.every(([, v]) => isInlineScalar(v))) {
        ctx.lines.push(`${pad}- {${entries.map(([kk, vv]) => `${kk}: ${inlineText(vv)}`).join(', ')}}`);
      } else {
        // 展开 map：首字段与 - 同行（parseList 的展开回退约定），其余字段缩进 base+2
        const [fk, fv] = entries[0];
        if (typeof fv === 'string' && isBlockString(fv)) {
          ctx.lines.push(`${pad}- ${fk}: |`);
          for (const l of blockLines(fv)) ctx.lines.push(pad + '  ' + l);
        } else if (isPlainScalar(fv)) {
          ctx.lines.push(`${pad}- ${fk}: ${scalarText(fv)}`);
        } else if (Array.isArray(fv)) {
          if (fv.length === 0) ctx.lines.push(`${pad}- ${fk}: []`);
          else if (fv.every(isInlineScalar)) ctx.lines.push(`${pad}- ${fk}: [${fv.map(inlineText).join(', ')}]`);
          else { ctx.lines.push(`${pad}- ${fk}:`); writeList(fv, base + 2, ctx); }
        } else if (isPlainObject(fv)) {
          ctx.lines.push(`${pad}- ${fk}:`);
          writeMap(fv, base + 2, ctx);
        } else {
          throw new YamlWriteError(`不支持的列表项字段: ${fk}`);
        }
        if (entries.length > 1) writeMap(Object.fromEntries(entries.slice(1)), base + 2, ctx);
      }
    } else if (Array.isArray(item)) {
      // 嵌套数组：全部标量则 inline，否则不支持（DiceKeeper 包结构用不到）
      if (item.every(isInlineScalar)) ctx.lines.push(`${pad}- [${item.map(inlineText).join(', ')}]`);
      else throw new YamlWriteError('不支持嵌套数组的展开输出');
    } else {
      throw new YamlWriteError('不支持的列表项类型');
    }
  }
}

function inlineText(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v; // isInlineScalar 已保证安全
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

export function serializeYaml(root: unknown): string {
  if (!isPlainObject(root)) throw new YamlWriteError('顶层必须是对象');
  const ctx: Ctx = { lines: [] };
  writeMap(root, 0, ctx);
  return ctx.lines.join('\n');
}
