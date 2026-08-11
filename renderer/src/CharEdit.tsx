// renderer/src/CharEdit.tsx — 手动车卡编辑表单（§11.10 微调）
// 属性/技能带悬浮说明（? 图标 hover 显示作用）；衍生值只读（主进程自动算）
import type { CharFields, CharSpec } from './global.d.ts';
import { InfoTip } from './InfoTip.tsx';

interface Props {
  fields: CharFields;
  spec: CharSpec;
  derived: Record<string, number>;
  onChange: (s: CharSpec) => void;
}

export function CharEdit({ fields, spec, derived, onChange }: Props) {
  const setAttr = (k: string, v: string) => {
    const n = v === '' ? 0 : Number(v);
    onChange({ ...spec, attributes: { ...spec.attributes, [k]: n } });
  };
  const setSkill = (k: string, v: string) => {
    const n = v === '' ? 0 : Number(v);
    onChange({ ...spec, skills: { ...spec.skills, [k]: n } });
  };

  return (
    <div className="char-edit">
      <div className="ce-row">
        <label>名字
          <input value={spec.name} onChange={(e) => onChange({ ...spec, name: e.target.value })} placeholder="无名调查员" />
        </label>
        <label>性别
          <select value={spec.gender ?? '男'} onChange={(e) => onChange({ ...spec, gender: e.target.value })}>
            <option>男</option>
            <option>女</option>
            <option>其他</option>
          </select>
        </label>
        <label>年龄
          <input type="number" min={15} max={89} value={spec.age || ''} onChange={(e) => onChange({ ...spec, age: Number(e.target.value) || 0 })} />
        </label>
        <label>职业（可下拉选或自由输入）
          <input
            list="dk-occupations"
            value={spec.occupation}
            onChange={(e) => onChange({ ...spec, occupation: e.target.value })}
            placeholder="选择或输入自定义职业"
          />
          <datalist id="dk-occupations">
            {fields.occupations.map((o) => <option key={o} value={o} />)}
          </datalist>
        </label>
      </div>

      <div className="ce-attrs">
        <div className="ce-section-title">属性（1-99）</div>
        {fields.attributes.map((a) => (
          <div className="ce-field" key={a.name}>
            <span className="ce-label">
              {a.name}
              <InfoTip text={a.desc} />
            </span>
            <input
              type="number" min={1} max={99}
              value={spec.attributes[a.name] ?? ''}
              onChange={(e) => setAttr(a.name, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="ce-derived">
        <div className="ce-section-title">衍生值（自动计算）</div>
        <div className="ce-derived-list">
          {fields.derived.map((d) => (
            <span key={d.name} className="ce-derived-item">
              {d.name} <b>{derived[d.name] ?? '-'}</b>
              <InfoTip text={d.desc} />
            </span>
          ))}
        </div>
      </div>

      <div className="ce-skills">
        <div className="ce-section-title">技能（0-99，右侧灰字为初始值）</div>
        <div className="ce-skill-grid">
          {fields.skills.map((s) => (
            <div className="ce-field" key={s.name}>
              <span className="ce-label">
                {s.name}
                <InfoTip text={s.desc} />
              </span>
              <input
                type="number" min={0} max={99}
                value={spec.skills[s.name] ?? ''}
                onChange={(e) => setSkill(s.name, e.target.value)}
              />
              <span className="ce-base">{s.base}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
