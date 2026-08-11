// dsl.ts — 裁决表达式 DSL（白名单、非图灵完备）
// 语法：骰子 / 数字 / 字段标识符 / + - * / / 比较 <= >= < > == != / and or not / 函数(白名单)
// 例：d100 <= SKILL | d100 <= floor(SKILL/2) | advantage(d100) <= SKILL | d20 + STR >= DC
// 安全：结构上无赋值/循环/函数定义/外部访问；未知字段报人话错误

import type { RNG } from './rng.ts';
import { roll, DiceSyntaxError, ALLOWED_SIDES } from './dice.ts';

export class DslError extends Error {}

export interface DslContext {
  fields: Record<string, number>; // 属性/技能/上下文变量（DC 等）
  rng: RNG;
  sides?: number[];
  deck?: Record<string, number[]>; // 预掷骰子牌堆（消费式）：判定本地化的关键——骰子由外层统一掷出，DSL 只做比较
}

export interface DslResult {
  ok: boolean;          // 判定结论（比较/逻辑表达式的最终值）
  value: number | boolean;
  rolls: number[];      // 审计：本表达式消耗的全部骰子
  expr: string;
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'dice'; value: string }
  | { kind: 'kw'; value: 'and' | 'or' | 'not' }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' } | { kind: 'rparen' };

type Node =
  | { t: 'num'; v: number }
  | { t: 'ident'; name: string }
  | { t: 'dice'; expr: string }
  | { t: 'binop'; op: string; l: Node; r: Node }
  | { t: 'unop'; op: '-' | 'not'; o: Node }
  | { t: 'call'; name: string; args: Node[] };

// 骰子感知函数：可访问参数（已求值）+ 参数是否骰子表达式（用于重掷/取明细）
// advantage(d) = 两次掷骰取低（参数已掷 1 次 + rollOnce 再掷 1 次）；disadvantage 取高
// successes(d, t) = 骰池计数：d 的逐面明细中 ≥ t 的个数
type Fn = (
  args: number[],
  exprs: (string | null)[],
  eng: { rollOnce(e: string | null): number; rollDetail(e: string | null): number[] },
) => number;

const FUNCTIONS: Record<string, Fn> = {
  floor: (a) => Math.floor(a[0]),
  half: (a) => Math.floor(a[0] / 2),
  fifth: (a) => Math.floor(a[0] / 5),
  min: (a) => Math.min(...a), // 奖励骰：min(d100, d100) 两次掷骰取有利值
  max: (a) => Math.max(...a), // 惩罚骰：max(d100, d100)
  advantage: (a, e, eng) => Math.min(a[0], eng.rollOnce(e[0])),
  disadvantage: (a, e, eng) => Math.max(a[0], eng.rollOnce(e[0])),
  successes: (a, e, eng) => eng.rollDetail(e[0]).filter((v) => v >= a[1]).length,
};

const TOKEN_RE =
  /(\d*d\d+(?:kh\d+|kl\d+|t\d+)?)|(\d+(?:\.\d+)?)|([\p{L}_][\p{L}\p{N}_]*)|(<=|>=|==|!=|<|>|\+|-|\*|\/|\(|\)|,)|(\s+)/gu;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    if (m.index! > last) throw new DslError(`无法解析的字符: ${JSON.stringify(src.slice(last, m.index!))}`);
    const [full, dice, num, ident, op, ws] = m;
    if (dice) tokens.push({ kind: 'dice', value: dice });
    else if (num) tokens.push({ kind: 'num', value: parseFloat(num) });
    else if (ident) {
      const v = ident.toLowerCase();
      if (v === 'and' || v === 'or' || v === 'not') tokens.push({ kind: 'kw', value: v });
      else tokens.push({ kind: 'ident', value: ident });
    } else if (op) {
      if (op === '(') tokens.push({ kind: 'lparen' });
      else if (op === ')') tokens.push({ kind: 'rparen' });
      else tokens.push({ kind: 'op', value: op });
    } // ws 忽略
    last = m.index! + full.length;
  }
  if (last !== src.length) throw new DslError(`无法解析的字符: ${JSON.stringify(src.slice(last))}`);
  if (tokens.length === 0) throw new DslError('空表达式');
  return tokens;
}

class DslEngine {
  private idx = 0;
  private ctx: DslContext;
  private tokens: Token[];
  private extraRolls: number[] = []; // 骰子感知函数（advantage/successes）内掷出的骰，审计时合并

  constructor(tokens: Token[], ctx: DslContext) {
    this.tokens = tokens;
    this.ctx = ctx;
  }

  parse(): Node {
    const node = this.or();
    if (this.idx !== this.tokens.length) throw new DslError(`意外的 token: ${JSON.stringify(this.tokens[this.idx])}`);
    return node;
  }

  eval(node: Node): DslResult {
    const { value, rolls } = this.evalNode(node, []);
    return { ok: value === true, value, rolls: [...rolls, ...this.extraRolls], expr: this.sourceOf(node) };
  }

  private sourceOf(_n: Node): string { return this.original; }
  private original = '';

  private evalNode(node: Node, rolls: number[]): { value: number | boolean; rolls: number[] } {
    switch (node.t) {
      case 'num': return { value: node.v, rolls };
      case 'ident': {
        const v = this.ctx.fields[node.name];
        if (v === undefined) {
          const known = Object.keys(this.ctx.fields);
          throw new DslError(`未知字段: ${node.name}。可用字段: ${known.length ? known.join(', ') : '（无）'}`);
        }
        return { value: v, rolls };
      }
      case 'dice': {
        // 优先消费预掷牌堆（级联判定共享同一颗骰）
        const queued = this.ctx.deck?.[node.expr];
        if (queued && queued.length > 0) {
          const v = queued.shift()!;
          return { value: v, rolls: [...rolls, v] };
        }
        const r = roll(node.expr, this.ctx.rng, this.ctx.sides ?? ALLOWED_SIDES);
        return { value: r.total, rolls: [...rolls, ...r.rolls] };
      }
      case 'unop': {
        const o = this.evalNode(node.o, rolls);
        if (node.op === 'not') {
          if (typeof o.value !== 'boolean') throw new DslError('not 只能用于布尔值');
          return { value: !o.value, rolls: o.rolls };
        }
        if (typeof o.value !== 'number') throw new DslError('一元负号只能用于数字');
        return { value: -o.value, rolls: o.rolls };
      }
      case 'binop': {
        const l = this.evalNode(node.l, rolls);
        const r = this.evalNode(node.r, l.rolls);
        return { value: applyBinop(node.op, l.value, r.value), rolls: r.rolls };
      }
      case 'call': {
        if (!(node.name in FUNCTIONS)) {
          throw new DslError(`未知函数: ${node.name}。可用: floor, half, fifth, min, max, advantage, disadvantage, successes`);
        }
        const fn = FUNCTIONS[node.name];
        const argVals: number[] = [];
        const argExprs: (string | null)[] = [];
        let acc = rolls;
        for (let i = 0; i < node.args.length; i++) {
          const a = node.args[i];
          // successes(5d10, 8)：首参数骰子由函数内部 rollDetail 掷（避免参数预掷 + 内部重掷重复）
          if (i === 0 && node.name === 'successes' && a.t === 'dice') {
            argVals.push(0);
            argExprs.push(a.expr);
            continue;
          }
          const av = this.evalNode(a, acc);
          if (typeof av.value !== 'number') throw new DslError(`${node.name}() 的参数必须是数字`);
          argVals.push(av.value);
          argExprs.push(a.t === 'dice' ? a.expr : null);
          acc = av.rolls;
        }
        return { value: fn(argVals, argExprs, this), rolls: acc };
      }
    }
  }

  // —— 语法：or → and → not(前缀) → comparison → additive → multiplicative → unary → primary ——
  private or(): Node {
    let l = this.and();
    while (this.matchKw('or')) l = { t: 'binop', op: 'or', l, r: this.and() };
    return l;
  }
  private and(): Node {
    let l = this.not();
    while (this.matchKw('and')) l = { t: 'binop', op: 'and', l, r: this.not() };
    return l;
  }
  private not(): Node {
    if (this.matchKw('not')) return { t: 'unop', op: 'not', o: this.not() };
    return this.comparison();
  }
  private comparison(): Node {
    let l = this.additive();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && ['<=', '>=', '<', '>', '==', '!='].includes(t.value)) {
        this.idx++;
        l = { t: 'binop', op: t.value, l, r: this.additive() };
      } else return l;
    }
  }
  private additive(): Node {
    let l = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.value === '+' || t.value === '-')) {
        this.idx++;
        l = { t: 'binop', op: t.value, l, r: this.multiplicative() };
      } else return l;
    }
  }
  private multiplicative(): Node {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.value === '*' || t.value === '/')) {
        this.idx++;
        l = { t: 'binop', op: t.value, l, r: this.unary() };
      } else return l;
    }
  }
  private unary(): Node {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === '-') { this.idx++; return { t: 'unop', op: '-', o: this.unary() }; }
    return this.primary();
  }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new DslError('表达式意外结束');
    if (t.kind === 'num') return { t: 'num', v: t.value };
    if (t.kind === 'dice') return { t: 'dice', expr: t.value };
    if (t.kind === 'ident') {
      // 函数调用？
      const next = this.peek();
      if (next && next.kind === 'lparen') {
        this.idx++;
        const args: Node[] = [];
        if (!(this.peek() && this.peek()!.kind === 'rparen')) {
          for (;;) {
            args.push(this.or());
            if (this.matchOp(',')) continue;
            break;
          }
        }
        const close = this.next();
        if (!close || close.kind !== 'rparen') throw new DslError(`${t.value}() 缺少右括号`);
        return { t: 'call', name: t.value, args };
      }
      return { t: 'ident', name: t.value };
    }
    if (t.kind === 'lparen') {
      const inner = this.or();
      const close = this.next();
      if (!close || close.kind !== 'rparen') throw new DslError('缺少右括号');
      return inner;
    }
    throw new DslError(`意外的 token: ${JSON.stringify(t)}`);
  }

  private peek(): Token | undefined { return this.tokens[this.idx]; }
  private next(): Token | undefined { return this.tokens[this.idx++]; }

  // 骰子感知函数用：重掷一颗骰（优先消费预掷牌堆，与参数求值共用同一规则）
  rollOnce(expr: string | null): number {
    if (!expr) throw new DslError('该函数需要一个骰子表达式参数（如 advantage(d100)）');
    const queued = this.ctx.deck?.[expr];
    const v = queued && queued.length > 0
      ? queued.shift()!
      : roll(expr, this.ctx.rng, this.ctx.sides ?? ALLOWED_SIDES).total;
    this.extraRolls.push(v);
    return v;
  }
  // 骰池明细（successes 用：逐面统计）
  rollDetail(expr: string | null): number[] {
    if (!expr) throw new DslError('该函数需要一个骰子表达式参数（如 successes(5d10, 8)）');
    const queued = this.ctx.deck?.[expr];
    const vs = queued && queued.length > 0
      ? [queued.shift()!]
      : roll(expr, this.ctx.rng, this.ctx.sides ?? ALLOWED_SIDES).rolls;
    this.extraRolls.push(...vs);
    return vs;
  }
  private matchKw(kw: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'kw' && t.value === kw) { this.idx++; return true; }
    return false;
  }
  private matchOp(op: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === op) { this.idx++; return true; }
    return false;
  }
}

function applyBinop(op: string, l: number | boolean, r: number | boolean): number | boolean {
  switch (op) {
    case '+': return num(l) + num(r);
    case '-': return num(l) - num(r);
    case '*': return num(l) * num(r);
    case '/': {
      const d = num(r);
      if (d === 0) throw new DslError('除数为 0');
      return Math.floor(num(l) / d);
    }
    case '<': return num(l) < num(r);
    case '<=': return num(l) <= num(r);
    case '>': return num(l) > num(r);
    case '>=': return num(l) >= num(r);
    case '==': return l === r;
    case '!=': return l !== r;
    case 'and': return bool(l) && bool(r);
    case 'or': return bool(l) || bool(r);
  }
  throw new DslError(`未知运算符: ${op}`);
}

function num(v: number | boolean): number {
  if (typeof v !== 'number') throw new DslError(`类型错误: 需要数字，得到 ${v}`);
  return v;
}
function bool(v: number | boolean): boolean {
  if (typeof v !== 'boolean') throw new DslError(`类型错误: 需要布尔值，得到 ${v}`);
  return v;
}

export function evaluate(src: string, ctx: DslContext): DslResult {
  const tokens = tokenize(src);
  const engine = new DslEngine(tokens, ctx);
  engine.original = src;
  const result = engine.eval(engine.parse());
  result.expr = src;
  return result;
}

export { DiceSyntaxError };
