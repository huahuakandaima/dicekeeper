// test/personas.test.ts — 人格包（§3.6：预设/校验/渲染）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_PERSONAS, renderPersona, validatePersona, findPersona, PersonaError } from '../src/personas.ts';

test('预设 6 档齐备，字段完整', () => {
  assert.equal(PRESET_PERSONAS.length, 6);
  const ids = new Set(PRESET_PERSONAS.map((p) => p.id));
  assert.equal(ids.size, 6, '预设 id 唯一');
  for (const p of PRESET_PERSONAS) {
    assert.doesNotThrow(() => validatePersona(p));
    assert.ok(p.tone.length > 0 && p.style.length > 0 && p.narration.length > 0 && p.rulings.length > 0);
  }
});

test('renderPersona：渲染人格段含全部要素', () => {
  const text = renderPersona(PRESET_PERSONAS[0]);
  assert.ok(text.includes('严谨老馆员'));
  assert.ok(text.includes('语气'));
  assert.ok(text.includes('主持风格'));
  assert.ok(text.includes('叙事偏好'));
  assert.ok(text.includes('裁决哲学'));
  assert.ok(text.includes('口头禅'));
});

test('validatePersona：非法输入拒收', () => {
  const base = {
    id: 'my', name: '我的风格', tone: 'x', style: 'y', narration: 'z', rulings: 'w', catchphrases: [],
  };
  assert.doesNotThrow(() => validatePersona(base));
  assert.throws(() => validatePersona({ ...base, id: '非法 id!' }), PersonaError);
  assert.throws(() => validatePersona({ ...base, tone: '' }), PersonaError);
  assert.throws(() => validatePersona({ ...base, catchphrases: '不是数组' }), PersonaError);
  assert.throws(() => validatePersona(null as never), PersonaError);
});

test('findPersona：预设/自建检索', () => {
  const custom = [{ id: 'my-style', name: '我的风格', tone: 'a', catchphrases: [], style: 'b', narration: 'c', rulings: 'd', isCustom: true }];
  assert.equal(findPersona(PRESET_PERSONAS, custom, 'librarian')?.name, '严谨老馆员');
  assert.equal(findPersona(PRESET_PERSONAS, custom, 'my-style')?.name, '我的风格');
  assert.equal(findPersona(PRESET_PERSONAS, custom, 'nope'), null);
});
