// renderer/src/global.d.ts — preload 桥类型
export {};

declare global {
  interface Window {
    dk: {
      settings: {
        get: () => Promise<{ baseUrl: string; apiKey: string; model: string; sqliteOk: boolean; defaultPersonaId?: string; tension?: { intensity: number; surprise: number; consequence: number } }>;
        set: (cfg: { baseUrl: string; apiKey: string; model: string; defaultPersonaId?: string; tension?: { intensity: number; surprise: number; consequence: number } }) => Promise<{ ok: boolean }>;
        test: (cfg: { baseUrl: string; apiKey: string }) => Promise<{ ok: boolean; status?: number; models?: string[]; error?: string }>;
      };
      personas: {
        list: () => Promise<{ presets: Persona[]; custom: Persona[]; defaultId: string }>;
        save: (p: Persona) => Promise<Persona>;
        delete: (id: string) => Promise<{ ok: boolean }>;
      };
      campaign: {
        list: () => Promise<{ id: string; name: string; pcCount: number; scenarioPackId?: string; msgs?: number; tokens?: number }[]>;
        create: (opts: { name: string; seed?: string; charName?: string; charSpec?: CharSpec; derivedOverrides?: Record<string, number>; scenarioPackId?: string; loaded?: boolean; personaId?: string }) => Promise<{ id: string; name: string }>;
        open: (id: string) => Promise<{ id: string; name: string; personaId?: string }>;
        delete: (id: string) => Promise<{ ok: boolean }>;
        characters: (id: string) => Promise<CharView[]>;
        tokens: (id?: string) => Promise<{ ok: boolean; campaignId?: string; messages?: number; system?: number; total?: number; msgCount?: number; error?: string }>;
      };
      characters: {
        preview: (seed?: string, loaded?: boolean) => Promise<CharPreview>;
        reroll: () => Promise<CharPreview>;
        fields: () => Promise<CharFields>;
        derive: (spec: { attributes: Record<string, number>; age?: number }, seed?: string) => Promise<Record<string, number>>;
        update: (spec: CharSpec, derivedOverrides?: Record<string, number>) => Promise<CharPreview>;
      };
      session: {
        start: () => Promise<{ id: string; campaignId: string }>;
        list: () => Promise<{ id: string; campaignId: string; started_at: string; summary?: string }[]>;
        open: (id: string) => Promise<SessionData>;
        end: () => Promise<{ session: { id: string; summary?: string }; summary: string }>;
      };
      entities: {
        suggest: (query?: string) => Promise<{ id: string; name: string; type: string; location?: string; importance: string; updated_at: string }[]>;
      };
      scene: {
        bar: () => Promise<{ persons: { id: string; name: string; here: boolean }[]; places: { id: string; name: string; here: boolean }[]; here: string }>;
      };
      check: (args: { skill: string; mode?: 'normal' | 'reward' | 'penalty' }) => Promise<CheckResult>;
      checkWithChat: (skill: string) => Promise<{ check: CheckResult; narrative: string; diceResults: string[]; issues: { kind: string; message: string }[]; promptPlayer?: string | null }>;
      chat: (action: string) => Promise<{ narrative: string; diceResults: string[]; issues: { kind: string; message: string }[]; promptPlayer?: string | null }>;
      onChunk: (cb: (text: string) => void) => void; // 流式叙事逐段回调
      onCheck: (cb: (info: { skill: string; value: number; label: string; detail: string; takenRoll: number }) => void) => void; // 检定结果推送（AI 叙事前先显示骰面）
      scenario: {
        info: () => Promise<{ id: string; name: string; hooks: string[] }>;
        list: () => Promise<PackMeta[]>;
      };
      packs: {
        list: () => Promise<{ rulePacks: PackMeta[]; scenarioPacks: PackMeta[] }>;
        import: () => Promise<ImportPackResult>;
        importText: (content: string, opts?: { force?: boolean; newId?: string }) => Promise<ImportPackResult>;
        export: (type: 'rule' | 'scenario', id: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
        delete: (type: 'rule' | 'scenario', id: string) => Promise<{ ok: boolean }>;
      };
      editor: {
        open: (type: 'rule' | 'scenario', id: string) => Promise<EditorOpenResult>;
        create: (req: { type?: 'rule' | 'scenario'; name?: string }) => Promise<{ ok: boolean; meta?: PackMeta; error?: string }>;
        save: (req: { type: 'rule' | 'scenario'; id: string; isBuiltin: boolean; obj: Record<string, unknown> }) => Promise<{ ok: boolean; meta?: PackMeta; savedAs?: string; error?: string }>;
        testCheck: (req: { obj: Record<string, unknown>; skill: string; value: number; mode?: 'normal' | 'reward' | 'penalty' }) => Promise<CheckResult>;
        testDist: (req: { obj: Record<string, unknown>; skill: string; value: number; mode?: 'normal' | 'reward' | 'penalty'; trials?: number }) => Promise<{ trials: number; counts: Record<string, number> }>;
        testLore: (req: { obj: Record<string, unknown>; text: string; budget?: number }) => Promise<{ budget: number; used: number; hits: { id: string; activation: 'blue' | 'green' | 'yellow'; content: string; priority: number; cost: number }[] }>;
        aiGenerate: (req: { type: 'rule' | 'scenario'; prompt: string; target: string }) => Promise<{ ok: boolean; target?: string; field?: string; draft?: unknown; yaml?: string; isWhole?: boolean; error?: string }>;
      };
      world: {
        updateFact: (id: string, patch: { fact?: string; importance?: string }) => Promise<{ id: string; fact: string; importance: string }>;
        deleteFact: (id: string) => Promise<boolean>;
        deleteRelation: (id: string) => Promise<boolean>;
        addFact: (req: { fact: string; importance?: string }) => Promise<{ id: string; fact: string }>;
        rollback: (changeId: string) => Promise<boolean>;
      };
      audit: {
        dice: () => Promise<{ id: string; expression: string; result: number; rolls: number[]; reason: string; requested_by: string }[]>;
        world: () => Promise<{
          entities: { id: string; type: string; name: string; data: Record<string, unknown> }[];
          facts: { id: string; fact: string; entity_refs: string[]; importance: string; created_at: string }[];
          relations: { id: string; a: string; b: string; relationType: string; description: string; since: string }[];
          changes: { id: string; actor: string; kind: string; target: string; before: unknown; after: unknown; created_at: string }[];
        }>;
      };
      ollama: {
        status: () => Promise<{ running: boolean; managed: boolean; e2e?: boolean; version?: string; ollamaDir: string; modelsDir: string; openaiUrl: string }>;
        setup: () => Promise<{ ok: boolean; error?: string; version?: string }>;
        start: () => Promise<{ ok: boolean; error?: string; version?: string }>;
        hwinfo: () => Promise<{ totalRamGB: number | null; vramGB: number | null; gpuName: string | null; recommend: string }>;
        models: () => Promise<{ name: string; size: number; digest: string; modifiedAt: string }[]>;
        pull: (name: string) => Promise<{ ok: boolean; error?: string }>;
        onProgress: (cb: (info: { phase: string; pct: number; label: string }) => void) => void;
      };
      room: {
        host: (port?: number) => Promise<{ ok: boolean; port?: number; addresses?: string[]; error?: string }>;
        close: () => Promise<{ ok: boolean }>;
        players: () => Promise<{ players: { id: string; name: string; joinedAt: number }[] }>;
        join: (opts: { address: string; name: string }) => Promise<{ ok: boolean; id?: string; players?: unknown[]; error?: string }>;
        send: (text: string) => Promise<{ ok: boolean; error?: string }>;
        leave: () => Promise<{ ok: boolean }>;
        onMsg: (cb: (m: { type: string; text?: string; dice?: string[]; prompt?: string | null; [k: string]: unknown }) => void) => void;
        onHostUser: (cb: (m: { name: string; text: string }) => void) => void;
        onHostNarrative: (cb: (m: { text: string; dice: string[]; prompt: string | null }) => void) => void;
        onPlayers: (cb: (m: { players: { id: string; name: string }[]; notice?: string }) => void) => void;
        onJoined: (cb: (m: { id: string; players: { id: string; name: string }[] }) => void) => void;
        onClosed: (cb: () => void) => void;
      };
    };
  }
}

export interface CharView {
  name: string;
  gender?: string;
  occupation: string;
  age: number;
  attributes: Record<string, number>;
  derived: Record<string, number>;
  skills: Record<string, number>;
}

export interface CharPreview {
  name: string;
  gender?: string;
  occupation: string;
  age: number;
  attributes: Record<string, number>;
  derived: Record<string, number>;
  topSkills: Record<string, number>;
  seed: string;
}

export interface CharSpec {
  name: string;
  gender?: string;
  age: number;
  occupation: string;
  attributes: Record<string, number>;
  skills: Record<string, number>;
}

export interface CharFields {
  attributes: { name: string; desc: string }[];
  skills: { name: string; base: number; desc: string }[];
  derived: { name: string; desc: string }[];
  occupations: string[];
}

export interface SessionData {
  session: { id: string; campaignId: string; started_at: string; summary?: string };
  messages: { role: 'user' | 'assistant' | 'tool'; content: string; diceResults?: string[] }[];
}

export interface CheckResult {
  outcome: string;
  label: string;
  diceRolls: number[];
  takenRoll: number;
  detail: string;
  value: number;
}

export interface PackMeta {
  id: string;
  name: string;
  version: string;
  type: 'rule' | 'scenario';
  isBuiltin: boolean;
  requires?: string;
}

export interface EditorOpenResult {
  ok: boolean;
  meta?: PackMeta;
  isBuiltin?: boolean;
  obj?: Record<string, unknown>; // 包对象（表单编辑）
  yaml?: string;                 // 序列化 YAML（源码视图）
  error?: string;
}

export interface PackSummary {
  npcCount?: number;
  locationCount?: number;
  plotCount?: number;
  loreCount?: number;
  skillCount?: number;
  attributeCount?: number;
  requires?: string;
}

export interface ImportPackResult {
  ok: boolean;
  canceled?: boolean;
  conflict?: boolean;   // 同名包已存在（未落盘，需确认覆盖/换名）
  pack?: PackMeta;
  summary?: PackSummary;
  content?: string;     // 原文件内容（冲突确认时回传 UI）
  error?: string;
}

export interface Persona {
  id: string;
  name: string;
  description?: string;
  tone: string;
  catchphrases: string[];
  style: string;
  narration: string;
  rulings: string;
  isCustom?: boolean;
}
