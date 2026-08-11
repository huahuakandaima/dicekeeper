// dice.ts — 骰子表达式引擎
// 语法（白名单）：常量、NdM / dM、后缀 khK / klK、骰池 tT、adv/dis、四则运算 + - * / ( )
// 例：2d6+3, d20+5, 4d6kh3, 2d20kh1 (优势), 5d10t8 (≥8 的成功数)
// 确定性：所有随机数来自外部注入的 RNG（同 seed 可复现，供审计回放）

import type { RNG } from './rng.ts';
import { rollInt } from './rng.ts';

export interface DiceResult {
  total: number;      // 表达式最终值（骰池 = 成功数）
  rolls: number[];    // 每颗骰子完整骰面（审计明细，kh/kl 时含被丢弃的）
  expr: string;       // 原始表达式
  kept?: number[];    // kh/kl 时保留的骰子
  successes?: number; // 骰池时成功个数
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' } | { kind: 'rparen' }
  | { kind: 'dice'; text: string }; // NdM / NdMkhK / NdMklK / NdMtT

export class DiceSyntaxError extends Error {}

const DICE_RE = /^(\d*)d(\d+)(?:((?:kh|kl))(\d+)|t(\d+))?$/i;

// —— 实现：递归下降 ——
export const ALLOWED_SIDES = [2, 4, 6, 8, 10, 12, 20, 100];

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  const re = /((?:\d+d\d+|d\d+)(?:kh\d+|kl\d+|t\d+)?)|(\d+)|([+\-*/()])/gi;
  let last = 0;
  for (const m of expr.matchAll(re)) {
    if (m.index! > last) throw new DiceSyntaxError(`无法解析的字符: ${JSON.stringify(expr.slice(last, m.index!))}`);
    const [full, dice, num, op] = m;
    if (dice) tokens.push({ kind: 'dice', text: dice });
    else if (num) tokens.push({ kind: 'num', value: parseInt(num, 10) });
    else if (op === '(' || op === ')') tokens.push(op === '(' ? { kind: 'lparen' } : { kind: 'rparen' });
    else tokens.push({ kind: 'op', value: op });
    last = m.index! + full.length;
  }
  if (last !== expr.length) throw new DiceSyntaxError(`无法解析的字符: ${JSON.stringify(expr.slice(last))}`);
  return tokens;
}

class Parser {
  private idx = 0;
  private tokens: Token[];
  private rng: RNG;
  private sides: number[];

  constructor(tokens: Token[], rng: RNG, sides: number[]) {
    this.tokens = tokens;
    this.rng = rng;
    this.sides = sides;
  }

  parse(): DiceResult {
    const v = this.expr();
    if (this.idx !== this.tokens.length) throw new DiceSyntaxError(`意外的 token: ${JSON.stringify(this.tokens[this.idx])}`);
    return v;
  }

  private peek(): Token | undefined { return this.tokens[this.idx]; }
  private next(): Token | undefined { return this.tokens[this.idx++]; }
  private expectOp(op: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === op) { this.idx++; return true; }
    return false;
  }

  private expr(): DiceResult {
    let left = this.term();
    while (true) {
      if (this.expectOp('+')) { const r = this.term(); left = combine(left, r, '+'); }
      else if (this.expectOp('-')) { const r = this.term(); left = combine(left, r, '-'); }
      else return left;
    }
  }

  private term(): DiceResult {
    let left = this.factor();
    while (true) {
      if (this.expectOp('*')) { const r = this.factor(); left = combine(left, r, '*'); }
      else if (this.expectOp('/')) { const r = this.factor(); left = combine(left, r, '/'); }
      else return left;
    }
  }

  private factor(): DiceResult {
    const t = this.next();
    if (!t) throw new DiceSyntaxError('表达式意外结束');
    if (t.kind === 'num') return { total: t.value, rolls: [], expr: String(t.value) };
    if (t.kind === 'lparen') {
      const inner = this.expr();
      const close = this.next();
      if (!close || close.kind !== 'rparen') throw new DiceSyntaxError('缺少右括号');
      return inner;
    }
    if (t.kind === 'dice') return this.rollDice(t.text);
    throw new DiceSyntaxError(`意外的 token: ${JSON.stringify(t)}`);
  }

  private rollDice(text: string): DiceResult {
    const m = DICE_RE.exec(text);
    if (!m) throw new DiceSyntaxError(`非法骰子: ${text}`);
    const count = m[1] ? parseInt(m[1], 10) : 1;
    const sides = parseInt(m[2], 10);
    if (!this.sides.includes(sides)) throw new DiceSyntaxError(`非法骰面 d${sides}（允许: ${this.sides.join(',')}）`);
    if (count < 1 || count > 100) throw new DiceSyntaxError(`骰子数量越界: ${count}`);
    const modifier = (m[3] || '').toLowerCase();
    const k = m[4] ? parseInt(m[4], 10) : 0;
    const target = m[5] ? parseInt(m[5], 10) : 0;

    const raw: number[] = [];
    for (let i = 0; i < count; i++) raw.push(rollInt(this.rng, 1, sides));

    if (target > 0) {
      if (target < 1 || target > sides) throw new DiceSyntaxError(`骰池目标 t${target} 越界（1~${sides}）`);
      const succ = raw.filter((r) => r >= target).length;
      return { total: succ, rolls: raw, expr: text, successes: succ };
    }
    if (modifier === 'kh' || modifier === 'kl') {
      if (k < 1 || k > count) throw new DiceSyntaxError(`${modifier}${k} 越界（1~${count}）`);
      const sorted = [...raw].sort((a, b) => (modifier === 'kh' ? b - a : a - b));
      const kept = sorted.slice(0, k);
      return { total: kept.reduce((a, b) => a + b, 0), rolls: raw, expr: text, kept };
    }
    return { total: raw.reduce((a, b) => a + b, 0), rolls: raw, expr: text };
  }
}

function combine(a: DiceResult, b: DiceResult, op: '+' | '-' | '*' | '/'): DiceResult {
  let total: number;
  switch (op) {
    case '+': total = a.total + b.total; break;
    case '-': total = a.total - b.total; break;
    case '*': total = a.total * b.total; break;
    default:
      if (b.total === 0) throw new DiceSyntaxError('除数为 0');
      total = Math.floor(a.total / b.total);
  }
  return { total, rolls: [...a.rolls, ...b.rolls], expr: `(${a.expr} ${op} ${b.expr})` };
}

export function roll(expr: string, rng: RNG, sides: number[] = ALLOWED_SIDES): DiceResult {
  return new Parser(tokenize(expr), rng, sides).parse();
}
