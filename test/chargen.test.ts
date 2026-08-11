// test/chargen.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRulePack } from '../src/rules.ts';
import { generateCharacter, buildCharacter, characterFields, cocDbBuild, ChargenError } from '../src/chargen.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pack = loadRulePack(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'coc7e.yaml'));

test('属性范围正确：常规 3d6*5 ∈[15,90]，非常规 (2d6+6)*5 ∈[40,90]', () => {
  for (let i = 0; i < 20; i++) {
    const c = generateCharacter(pack, { seed: `range-${i}` });
    for (const k of ['STR', 'CON', 'DEX', 'APP', 'POW']) {
      assert.ok(c.attributes[k] >= 15 && c.attributes[k] <= 90, `${k}=${c.attributes[k]}`);
    }
    for (const k of ['SIZ', 'INT', 'EDU']) {
      assert.ok(c.attributes[k] >= 40 && c.attributes[k] <= 90, `${k}=${c.attributes[k]}`);
    }
  }
});

test('衍生值：HP=(SIZ+CON)/10、MP=POW/5、SAN=POW、幸运∈[15,90]', () => {
  const c = generateCharacter(pack, { seed: 'derived' });
  assert.equal(c.derived.HP, Math.floor((c.attributes.SIZ + c.attributes.CON) / 10));
  assert.equal(c.derived.MP, Math.floor(c.attributes.POW / 5));
  assert.equal(c.derived.SAN, c.attributes.POW);
  assert.ok(c.derived.幸运 >= 15 && c.derived.幸运 <= 90);
});

test('DB/Build 查表', () => {
  assert.deepEqual(cocDbBuild(60), { db: '-2', build: -2 });
  assert.deepEqual(cocDbBuild(90), { db: '0', build: 0 });
  assert.deepEqual(cocDbBuild(150), { db: '+1d4', build: 1 });
});

test('技能：职业技能 >= base，总加点 = 职业点 + 兴趣点', () => {
  const c = generateCharacter(pack, { seed: 'skills' });
  const occ = pack.chargen!.occupations!.find((o) => o.name === c.occupation)!;
  const fields = characterFields(c);
  // 职业技能都大于等于 base
  for (const s of occ.skills) {
    const base = pack.character_sheet.skills.find((x) => x.name === s)?.base ?? 0;
    assert.ok(c.skills[s] >= base, `${s}: ${c.skills[s]} < base ${base}`);
  }
  // 总点数校验：职业点 + 兴趣点 = 全部技能超出 base 之和
  const occPoints = Math.floor(evaluate2(occ.points, c));
  const interest = c.attributes.INT * 2;
  let spent = 0;
  for (const s of pack.character_sheet.skills) {
    const spentHere = (c.skills[s.name] ?? 0) - s.base;
    if (spentHere > 0) spent += spentHere;
  }
  assert.ok(spent <= occPoints + interest, `spent=${spent} 超过预算 ${occPoints}+${interest}`);
  assert.equal(c.occupation, occ.name);
});

function evaluate2(points: string, c: ReturnType<typeof generateCharacter>): number {
  // 复算职业点（EDU*2+INT*2 等）
  const r = points.replace(/EDU|INT|STR|CON|DEX|APP|POW|SIZ/g, (m) => String(c.attributes[m]));
  // 简单四则运算求值（无骰子）
  const parts = r.match(/\d+|[+*()]/g)!.join('');
  // eslint-disable-next-line no-eval
  return Function(`"use strict";return (${parts})`)() as number;
}

test('确定性：同 seed 生成同一角色', () => {
  const a = generateCharacter(pack, { seed: 'fixed-chargen' });
  const b = generateCharacter(pack, { seed: 'fixed-chargen' });
  assert.deepEqual(a, b);
});

test('指定职业生效', () => {
  const c = generateCharacter(pack, { seed: 'doc', occupation: '医生' });
  assert.equal(c.occupation, '医生');
  assert.ok(c.skills['医学'] >= 1);
});

test('characterFields 合并属性与技能', () => {
  const c = generateCharacter(pack, { seed: 'fields' });
  const f = characterFields(c);
  assert.equal(f.STR, c.attributes.STR);
  assert.equal(f['侦查'], c.skills['侦查']);
  assert.equal(f.SKILL, undefined); // 占位符由 adjudicate 层注入
});

// —— 手动车卡（§11.10 微调）——
test('buildCharacter：手填属性/技能 + 衍生自动算', () => {
  const c = buildCharacter(pack, {
    name: '手填调查员',
    age: 30,
    occupation: '医生',
    attributes: { STR: 50, CON: 60, DEX: 40, APP: 50, INT: 70, POW: 65, EDU: 80, SIZ: 55 },
    skills: { 医学: 80, 急救: 60, 侦查: 50, 聆听: 20 },
  }, 'manual-1');
  assert.equal(c.name, '手填调查员');
  assert.equal(c.age, 30);
  assert.equal(c.occupation, '医生');
  assert.equal(c.attributes.STR, 50);
  assert.equal(c.skills['医学'], 80);
  // 衍生：HP = (SIZ+CON)/10 = 11；MP = POW/5 = 13；SAN = POW = 65
  assert.equal(c.derived.HP, Math.floor((55 + 60) / 10));
  assert.equal(c.derived.MP, Math.floor(65 / 5));
  assert.equal(c.derived.SAN, 65);
  assert.equal(c.skills['会计'], undefined, 'buildCharacter 不自动补技能（UI 侧预填全量）');
});

test('buildCharacter：非法输入拒收（属性越界/空职业/技能越界）', () => {
  const base = {
    name: 'x', age: 30, occupation: '医生',
    attributes: { STR: 50, CON: 60, DEX: 40, APP: 50, INT: 70, POW: 65, EDU: 80, SIZ: 55 },
    skills: { 医学: 80 },
  };
  assert.throws(() => buildCharacter(pack, { ...base, attributes: { ...base.attributes, STR: 0 } }), ChargenError);
  assert.throws(() => buildCharacter(pack, { ...base, attributes: { ...base.attributes, STR: 150 } }), ChargenError);
  assert.throws(() => buildCharacter(pack, { ...base, occupation: '' }), ChargenError);
  assert.throws(() => buildCharacter(pack, { ...base, skills: { 医学: 101 } }), ChargenError);
  assert.throws(() => buildCharacter(pack, { ...base, age: 10 }), ChargenError);
  assert.doesNotThrow(() => buildCharacter(pack, base));
});

test('buildCharacter：自定义职业可自由输入（不在规则包列表也接受）', () => {
  const c = buildCharacter(pack, {
    name: '自定义职业者',
    age: 28,
    occupation: '摆渡人', // 规则包没有的职业
    attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, INT: 50, POW: 50, EDU: 50, SIZ: 50 },
    skills: { 侦查: 60 },
  }, 'custom-occ');
  assert.equal(c.occupation, '摆渡人');
  assert.equal(c.skills['侦查'], 60);
});

test('buildCharacter：derivedOverrides 覆盖衍生值（重掷幸运保持 UI 值）', () => {
  const base = {
    name: 'x', age: 30, occupation: '医生',
    attributes: { STR: 50, CON: 60, DEX: 40, APP: 50, INT: 70, POW: 65, EDU: 80, SIZ: 55 },
    skills: { 医学: 80 },
  };
  const c = buildCharacter(pack, base, 's', { 幸运: 77 });
  assert.equal(c.derived['幸运'], 77);
  assert.equal(c.derived.HP, Math.floor((55 + 60) / 10), '未覆盖的衍生仍自动算');
});

test('灌铅模式（loaded）：属性整体右移，且同 seed 确定性', () => {
  const sum = (c: { attributes: Record<string, number> }) => Object.values(c.attributes).reduce((s, v) => s + v, 0);
  // 同 seed：灌铅每个属性取两次投更高 → 总值 ≥ 普通
  const normal = generateCharacter(pack, { seed: 'loaded-seed' });
  const loaded = generateCharacter(pack, { seed: 'loaded-seed', loaded: true });
  assert.ok(sum(loaded) >= sum(normal), `灌铅总值 ${sum(loaded)} 应 ≥ 普通 ${sum(normal)}`);
  // 确定性：同 seed 同 loaded 结果一致
  const loaded2 = generateCharacter(pack, { seed: 'loaded-seed', loaded: true });
  assert.deepEqual(loaded.attributes, loaded2.attributes);
  // 灌铅不改变合法范围
  for (const v of Object.values(loaded.attributes)) assert.ok(v >= 15 && v <= 90);
  // 多 seed 统计：灌铅均值显著高于普通（100 次）
  let s1 = 0, s2 = 0;
  for (let i = 0; i < 100; i++) {
    s1 += sum(generateCharacter(pack, { seed: `m-${i}` }));
    s2 += sum(generateCharacter(pack, { seed: `m-${i}`, loaded: true }));
  }
  const avg1 = s1 / 100, avg2 = s2 / 100;
  assert.ok(avg2 > avg1 + 5, `灌铅均值 ${avg2.toFixed(1)} 应明显高于普通 ${avg1.toFixed(1)}`);
});
