// electron/preload.cjs — 渲染进程桥（contextIsolation 安全边界）
// CJS 手写（sandbox 兼容，不参与 vite 打包）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dk', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (cfg) => ipcRenderer.invoke('settings:set', cfg),
    test: (cfg) => ipcRenderer.invoke('settings:test', cfg),
  },
  personas: {
    list: () => ipcRenderer.invoke('personas:list'),
    save: (p) => ipcRenderer.invoke('personas:save', p),
    delete: (id) => ipcRenderer.invoke('personas:delete', id),
  },
  campaign: {
    list: () => ipcRenderer.invoke('campaign:list'),
    create: (opts) => ipcRenderer.invoke('campaign:create', opts),
    open: (id) => ipcRenderer.invoke('campaign:open', id),
    delete: (id) => ipcRenderer.invoke('campaign:delete', id),
    characters: (id) => ipcRenderer.invoke('campaign:characters', id),
    tokens: (id) => ipcRenderer.invoke('campaign:tokens', id),
  },
  characters: {
    preview: (seed) => ipcRenderer.invoke('characters:preview', seed),
    reroll: () => ipcRenderer.invoke('characters:reroll'),
    fields: () => ipcRenderer.invoke('characters:fields'),
    derive: (spec, seed) => ipcRenderer.invoke('characters:derive', spec, seed),
    update: (spec, overrides) => ipcRenderer.invoke('characters:update', spec, overrides),
  },
  session: {
    start: () => ipcRenderer.invoke('session:start'),
    list: () => ipcRenderer.invoke('session:list'),
    open: (id) => ipcRenderer.invoke('session:open', id),
    end: () => ipcRenderer.invoke('session:end'),
  },
  entities: {
    suggest: (query) => ipcRenderer.invoke('entities:suggest', query),
  },
  scene: {
    bar: () => ipcRenderer.invoke('scene:bar'),
  },
  check: (args) => ipcRenderer.invoke('check:skill', args),
  checkWithChat: (skill) => ipcRenderer.invoke('check:withChat', skill),
  chat: (action) => ipcRenderer.invoke('chat:send', action),
  onChunk: (cb) => { ipcRenderer.on('chat:chunk', (_e, text) => cb(text)); },
  onCheck: (cb) => { ipcRenderer.on('chat:check', (_e, info) => cb(info)); },
  scenario: {
    info: () => ipcRenderer.invoke('scenario:info'),
    list: () => ipcRenderer.invoke('scenario:list'),
  },
  packs: {
    list: () => ipcRenderer.invoke('packs:list'),
    import: () => ipcRenderer.invoke('packs:import'),
    importText: (content, opts) => ipcRenderer.invoke('packs:importText', opts ? { content, ...opts } : content),
    export: (type, id) => ipcRenderer.invoke('packs:export', type, id),
    delete: (type, id) => ipcRenderer.invoke('packs:delete', type, id),
  },
  editor: {
    open: (type, id) => ipcRenderer.invoke('editor:open', type, id),
    create: (req) => ipcRenderer.invoke('editor:create', req),
    save: (req) => ipcRenderer.invoke('editor:save', req),
    testCheck: (req) => ipcRenderer.invoke('editor:testCheck', req),
    testDist: (req) => ipcRenderer.invoke('editor:testDist', req),
    testLore: (req) => ipcRenderer.invoke('editor:testLore', req),
    aiGenerate: (req) => ipcRenderer.invoke('editor:aiGenerate', req),
  },
  world: {
    updateFact: (id, patch) => ipcRenderer.invoke('world:updateFact', id, patch),
    deleteFact: (id) => ipcRenderer.invoke('world:deleteFact', id),
    deleteRelation: (id) => ipcRenderer.invoke('world:deleteRelation', id),
    addFact: (req) => ipcRenderer.invoke('world:addFact', req),
    rollback: (changeId) => ipcRenderer.invoke('world:rollback', changeId),
  },
  audit: {
    dice: () => ipcRenderer.invoke('audit:dice'),
    world: () => ipcRenderer.invoke('audit:world'),
  },
  ollama: {
    status: () => ipcRenderer.invoke('ollama:status'),
    setup: () => ipcRenderer.invoke('ollama:setup'),
    start: () => ipcRenderer.invoke('ollama:start'),
    hwinfo: () => ipcRenderer.invoke('ollama:hwinfo'),
    models: () => ipcRenderer.invoke('ollama:models'),
    pull: (name) => ipcRenderer.invoke('ollama:pull', name),
    onProgress: (cb) => { ipcRenderer.on('ollama:progress', (_e, info) => cb(info)); },
  },
  room: {
    host: (port) => ipcRenderer.invoke('room:host', port ?? 0),
    close: () => ipcRenderer.invoke('room:close'),
    players: () => ipcRenderer.invoke('room:players'),
    join: (opts) => ipcRenderer.invoke('room:join', opts),
    send: (text) => ipcRenderer.invoke('room:send', text),
    leave: () => ipcRenderer.invoke('room:leave'),
    onMsg: (cb) => { ipcRenderer.on('room:msg', (_e, m) => cb(m)); },
    onHostUser: (cb) => { ipcRenderer.on('room:hostUser', (_e, m) => cb(m)); },
    onHostNarrative: (cb) => { ipcRenderer.on('room:hostNarrative', (_e, m) => cb(m)); },
    onPlayers: (cb) => { ipcRenderer.on('room:players', (_e, m) => cb(m)); },
    onJoined: (cb) => { ipcRenderer.on('room:joined', (_e, m) => cb(m)); },
    onClosed: (cb) => { ipcRenderer.on('room:closed', (_e) => cb()); },
  },
});
