// tension.ts — 张力仪表（戏剧引擎 §11.7）
// 三件套：① 玩家可调滑杆（张力强度/意外频率/失败代价，0-100，持久化 settings）
//        ② 本地张力计算：基础=玩家强度滑杆；修正=倒计时线索（+15）+ 最近检定失败上浮（每次+5 封顶+20）
//        ③ prompt 红线注入：每 session ≥1 次两难/时限（频率随滑杆）；检定失败不许无事发生；NPC 独立动机
// 判定本地化同源：张力是本地数值，AI 只按数值调叙事节奏

export interface TensionSettings {
  intensity: number;   // 张力强度（基础档位）：0 松弛 ~ 100 紧绷
  surprise: number;    // 意外频率：0 平铺直叙 ~ 100 高频率意外/转折
  consequence: number; // 失败代价严苛度：0 失败轻松 ~ 100 失败要付代价
}

export const DEFAULT_TENSION: TensionSettings = { intensity: 50, surprise: 50, consequence: 50 };

export interface TensionCtx {
  settings: TensionSettings;
  level: number; // 当前张力 0-100（本地计算）
  hasCountdown: boolean; // 存在倒计时线索（时间压力）
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// 本地张力计算（§11.7：基于最近 N 轮成功率/推进/危险事件 + 玩家滑杆）
// - 基础 = 玩家强度滑杆（intensity）
// - 倒计时线索（plot 名含倒计时/期限/将至 且 open）→ +15（时间压力拉满）
// - 最近玩家检定失败 → 每次 +5，封顶 +20（世界更危险）
export function computeTension(
  settings: TensionSettings,
  opts: { hasCountdown?: boolean; recentCheckFails?: number },
): TensionCtx {
  let level = settings.intensity;
  if (opts.hasCountdown) level += 15;
  level += clamp((opts.recentCheckFails ?? 0), 0, 4) * 5; // 最多 4 次 × 5 = +20
  return {
    settings,
    level: clamp(Math.round(level), 0, 100),
    hasCountdown: opts.hasCountdown ?? false,
  };
}

// 剧本包倒计时线索检测：plot 实体 open 且名字含倒计时/期限/将至/临近
export function hasCountdownPlot(world: { entities: Map<string, { type: string; name: string; data: Record<string, unknown> }> }): boolean {
  for (const e of world.entities.values()) {
    if (e.type !== 'plot') continue;
    if ((e.data as Record<string, unknown>).status !== 'open') continue;
    if (/倒计时|期限|将至|临近|最后|截止/.test(e.name)) return true;
  }
  return false;
}

// prompt 注入段（主持人行为红线，§11.7）：
// 两难/时限频率随 surprise 滑杆；失败代价随 consequence 滑杆
export function buildTensionPrompt(ctx: TensionCtx): string {
  const { level, settings, hasCountdown } = ctx;
  const freq = settings.surprise >= 70 ? '高频' : settings.surprise <= 30 ? '低频' : '适中';
  const cost = settings.consequence >= 70 ? '严苛' : settings.consequence <= 30 ? '宽容' : '常规';
  const levelDesc = level >= 70 ? '高（紧迫感强，倒计时感明显）' : level <= 30 ? '低（可以松弛铺垫）' : '中（张弛有度）';
  const countdownNote = hasCountdown ? '（当前存在未完结的倒计时线索，请在叙事中体现时间压力）' : '';
  return `【张力与戏剧】（当前张力 ${level}/100，强度 ${levelDesc}${countdownNote}）
- 主持人行为红线（戏剧引擎）：
  1. 每 session 至少制造 1 次两难抉择（玩家必须在两个都想要/都不愿失去的选项间取舍）与 1 次时限事件（某行动必须在时间压力下完成）——频率按"意外频率"滑杆（当前：${freq}）。
  2. 检定失败不许"无事发生"：必须给"成功但付出代价"或"意外后果"，让失败推动剧情，而不是让剧情静止。
  3. NPC 有独立动机：会拒绝、会讨价还价、会隐瞒、会背叛——不无条件配合玩家。
  4. 失败代价按滑杆调节（当前：${cost}）：${cost === '严苛' ? '失败可能导致受伤/失去资源/恶化局势' : cost === '宽容' ? '失败主要影响叙事走向，少造成资源损失' : '失败有明确后果但不致命'}。`;
}
