// AI 사용량 위젯 — 데이터 수집
// Claude Code 기록(~/.claude/projects/**.jsonl)과 Codex 기록(~/.codex/sessions/**.jsonl)을 읽기만 해서
// 오늘 쓴 토큰, 남은 사용 한도, 지금 돌아가는 세션을 모음. 기록 파일은 절대 고치지 않음.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const CLAUDE_PROJECTS = path.join(CLAUDE_DIR, 'projects');
const CLAUDE_LIVE = path.join(CLAUDE_DIR, 'sessions');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const CODEX_SESSIONS = path.join(CODEX_HOME, 'sessions');
const DATA_DIR = path.join(HOME, '.ai-usage-widget');
const CLAUDE_USAGE = path.join(DATA_DIR, 'claude-usage.json');

const RECENT_MS = 3 * 60e3;    // 이 시간 안에 기록이 바뀐 세션은 목록에 보임
const WORKING_MS = 90e3;       // 이 시간 안에 움직였고 대기 상태가 아니면 '작업 중'
const READ_CHUNK = 4 * 1024 * 1024;

// ───────── 작은 도구들 ─────────
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const toMs = (v) => typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : (typeof v === 'string' ? Date.parse(v) || 0 : 0);
const snip = (s, n = 40) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (p) => path.basename(String(p || '').replace(/[\\/]+$/, '')) || '';
const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function readRange(fp, from, to) {
  const fd = fs.openSync(fp, 'r');
  try {
    const out = [];
    for (let pos = from; pos < to;) {
      const n = Math.min(READ_CHUNK, to - pos), buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, pos); if (!got) break;
      out.push(got === n ? buf : buf.subarray(0, got)); pos += got;
    }
    return Buffer.concat(out).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// 파일을 끝까지 따라 읽음 (새로 붙은 줄만 넘겨줌)
function tail(F, onLine) {
  const st = statOf(F.fp); if (!st) return;
  F.mtime = st.mtimeMs;
  if (st.size < F.offset) { F.offset = 0; F.rem = ''; } // 파일이 새로 써졌으면 처음부터
  if (st.size === F.offset) return;
  const txt = F.rem + readRange(F.fp, F.offset, st.size);
  F.offset = st.size;
  const lines = txt.split('\n'); F.rem = lines.pop();
  for (const l of lines) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    onLine(F, o);
  }
}

const emptyTokens = () => ({ total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// ───────── Claude Code ─────────
// 도구 이름 → 사람이 읽는 말
function claudeToolLabel(name, inp) {
  inp = inp || {};
  const f = inp.file_path || inp.notebook_path;
  if (name === 'Read') return '읽는 중 ' + base(f);
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return '수정 중 ' + base(f);
  if (name === 'Bash') return '실행 중 ' + snip(inp.description || inp.command, 28);
  if (name === 'Grep' || name === 'Glob') return '찾는 중 ' + snip(inp.pattern, 24);
  if (name === 'WebSearch') return '웹 검색 ' + snip(inp.query, 24);
  if (name === 'WebFetch') { try { return '웹 읽기 ' + new URL(inp.url).host; } catch { return '웹 읽기'; } }
  if (name === 'Task' || name === 'Agent') return '도우미 호출 ' + snip(inp.description, 22);
  if (name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate') return '할 일 정리';
  if (name === 'AskUserQuestion') return '질문 중';
  if (name === 'ExitPlanMode') return '계획 확인 요청';
  if (name && name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
  return name || '작업 중';
}

class Claude {
  constructor() { this.reset(); }
  reset() {
    this.day = startOfDay();
    this.files = new Map();   // 파일경로 → { fp, offset, rem, mtime, sub }
    this.msgs = new Map();    // 메시지 id → 토큰 (같은 메시지가 여러 줄에 나뉘어 적힘 → 마지막 것)
    this.sessions = new Map();// sessionId → 상태
  }
  scan() {
    if (startOfDay() !== this.day) this.reset(); // 자정이 지나면 오늘 것만 다시 셈
    const walk = (dir, depth) => {
      for (const e of ls(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
        if (!e.name.endsWith('.jsonl') || this.files.has(p)) continue;
        const st = statOf(p); if (!st || st.mtimeMs < this.day) continue;
        this.files.set(p, { fp: p, offset: 0, rem: '', mtime: st.mtimeMs, sub: depth > 1 });
      }
    };
    walk(CLAUDE_PROJECTS, 0); // 0 projects · 1 프로젝트 폴더(세션 파일) · 2 세션 폴더 · 3 subagents
  }
  tick() { for (const F of this.files.values()) { try { tail(F, (F, o) => this.line(F, o)); } catch { } } }
  line(F, o) {
    const ts = Date.parse(o.timestamp) || 0;
    const m = o.message;
    if (o.type === 'assistant' && m && m.usage && ts >= this.day) {
      const u = m.usage;
      this.msgs.set((m.id || F.fp + ':' + ts) + ':' + (o.requestId || ''), {
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
      });
    }
    if (F.sub || o.isSidechain || !o.sessionId) return; // 도우미(서브에이전트) 기록은 토큰만 셈
    let S = this.sessions.get(o.sessionId);
    if (!S) { S = { id: o.sessionId, cwd: '', state: 'idle', label: '', lastAt: 0, since: 0, model: '', ctxTokens: 0, file: F.fp }; this.sessions.set(o.sessionId, S); }
    if (o.cwd) S.cwd = o.cwd;
    if (ts) S.lastAt = Math.max(S.lastAt, ts);
    const set = (state, label) => { if (S.state !== state) S.since = ts || Date.now(); S.state = state; S.label = label; };
    if (o.type === 'assistant' && m) {
      if (m.model && m.model !== '<synthetic>') S.model = m.model;
      if (m.usage) S.ctxTokens = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0) + (m.usage.output_tokens || 0);
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use') set(c.name === 'AskUserQuestion' || c.name === 'ExitPlanMode' ? 'ask' : 'work', claudeToolLabel(c.name, c.input));
        else if (c.type === 'thinking') set('work', '생각 중');
        else if (c.type === 'text') set('work', '답변 쓰는 중');
      }
      if (m.stop_reason === 'end_turn') set('wait', '답변 완료 · 다음 지시 대기');
    } else if (o.type === 'user' && m && !o.isMeta) {
      const arr = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      if (arr.some(c => c && c.type === 'tool_result')) set('work', '결과 확인 중');
      else if (arr.some(c => c && c.type === 'text' && c.text && !/^<(command|local-command)/.test(c.text))) {
        const t = arr.find(c => c.type === 'text').text;
        if (/^\[Request interrupted/.test(t)) set('wait', '중단됨 · 대기');
        else set('work', '생각 중');
      }
    }
  }
  live() { // 지금 열려 있는 Claude Code (~/.claude/sessions/<pid>.json, 끄면 지워짐). 폴더가 없으면 null
    let names; try { names = fs.readdirSync(CLAUDE_LIVE).filter(n => /^\d+\.json$/.test(n)); } catch { return null; }
    const live = new Set();
    for (const n of names) {
      const o = readJson(path.join(CLAUDE_LIVE, n));
      try { if (o && o.sessionId && o.pid) { process.kill(o.pid, 0); live.add(o.sessionId); } } catch (e) { if (e.code === 'EPERM') live.add(o.sessionId); }
    }
    return live;
  }
  today() {
    const t = emptyTokens();
    for (const u of this.msgs.values()) { t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; }
    t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
    return t;
  }
  limits() { // 상태줄(statusline.js)이 받아 적어 둔 사용 한도
    const u = readJson(CLAUDE_USAGE); if (!u) return { limits: null, perSession: {} };
    const now = Date.now();
    const win = (w, label) => {
      if (!w || typeof w.used !== 'number') return null;
      const resetsAt = toMs(w.resets_at);
      if (resetsAt && resetsAt < now) return { label, remaining: 100, resetsAt: 0, reset: true };
      return { label, remaining: Math.max(0, Math.min(100, 100 - w.used)), resetsAt };
    };
    const windows = [win(u.five_hour, '5시간'), win(u.seven_day, '주간')].filter(Boolean);
    return { limits: windows.length ? { windows, at: u.at || 0 } : null, perSession: u.sessions || {} };
  }
  snapshot(now, apiLimits) {
    const live = this.live();
    const { limits: slLimits, perSession } = this.limits();
    // 계정에 직접 물어본 값(claude-api.js)과 상태줄이 적어 둔 값 중 더 최근 것
    const limits = apiLimits && (!slLimits || apiLimits.at >= slLimits.at) ? apiLimits : slLimits;
    const list = [];
    for (const S of this.sessions.values()) {
      const isLive = live ? live.has(S.id) : false;
      const recent = now - S.lastAt < RECENT_MS;
      if (!isLive && !recent) continue;
      if (live && !isLive && S.state === 'wait') continue; // 터미널을 닫은 세션
      const ps = perSession[S.id] || {};
      const ctx = typeof ps.ctx === 'number' ? ps.ctx : (S.ctxTokens ? Math.min(100, S.ctxTokens / (/\[1m\]/.test(S.model) ? 1e6 : 2e5) * 100) : null);
      list.push(sessionView('claude', S, now, ctx, ps.model || prettyClaudeModel(S.model)));
    }
    return {
      installed: !!statOf(CLAUDE_DIR),
      limits, today: this.today(),
      active: list.filter(s => s.status === 'work').length,
      sessions: list,
    };
  }
}
const prettyClaudeModel = (m) => {
  const x = /claude-(\w+)-(\d+)(?:-(\d+))?/.exec(m || '');
  if (!x) return m || '';
  return x[1][0].toUpperCase() + x[1].slice(1) + ' ' + x[2] + (x[3] && x[3].length <= 2 ? '.' + x[3] : '');
};

function sessionView(agent, S, now, ctx, model) {
  let status = S.state;
  if (status === 'work' && now - S.lastAt > WORKING_MS) status = 'idle';
  return {
    agent, id: S.id, project: base(S.cwd) || '(폴더 모름)', status,
    label: status === 'idle' ? '조용함' : S.label, since: S.since, lastAt: S.lastAt,
    ctx: typeof ctx === 'number' ? Math.round(ctx) : null, model: model || '',
  };
}

// ───────── Codex ─────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. token_count 이벤트에 누적 토큰과 사용 한도(rate_limits)가 그대로 들어 있음
function codexToolLabel(pl) {
  let args = pl.arguments || pl.input || '';
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { raw: args }; } }
  const cmd = args.cmd || args.command;
  const cmdStr = Array.isArray(cmd) ? cmd.filter(x => !/^(bash|zsh|sh|-lc|-c)$/.test(x)).join(' ') : cmd;
  const name = pl.name || '';
  if (cmdStr) return '실행 중 ' + snip(cmdStr, 28);
  if (name === 'apply_patch') { const f = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(args.raw || args.input || ''); return '수정 중 ' + (f ? base(f[1]) : ''); }
  if (name === 'update_plan') return '계획 정리';
  if (name === 'web_search' || name === 'web_search_call') return '웹 검색';
  if (name.startsWith('mcp__')) return name.split('__').slice(1).join(' · ');
  return name || '작업 중';
}

const windowLabel = (min) => !min ? '' : min === 300 ? '5시간' : min === 10080 ? '주간' : min % 1440 === 0 ? `${min / 1440}일` : min % 60 === 0 ? `${min / 60}시간` : `${min}분`;

class Codex {
  constructor() { this.reset(); this.rate = null; this.bootRate = false; }
  reset() {
    this.day = startOfDay();
    this.files = new Map(); // fp → { fp, offset, rem, mtime, sid, base, last }
    this.sessions = new Map();
  }
  dayDirs(days) {
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 864e5);
      out.push(path.join(CODEX_SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
    }
    return out;
  }
  scan() {
    if (startOfDay() !== this.day) this.reset();
    for (const dir of this.dayDirs(7)) {
      for (const e of ls(dir)) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const p = path.join(dir, e.name); if (this.files.has(p)) continue;
        const st = statOf(p); if (!st || st.mtimeMs < this.day) continue;
        this.files.set(p, { fp: p, offset: 0, rem: '', mtime: st.mtimeMs, sid: '', child: false, base: null, last: null });
      }
    }
    if (!this.rate && !this.bootRate) { this.bootRate = true; this.rateFromHistory(); }
  }
  // 오늘 Codex 를 아직 안 썼으면, 가장 최근 기록 끝부분에서 마지막 사용 한도를 찾음
  rateFromHistory() {
    let best = null;
    for (const dir of this.dayDirs(30)) {
      for (const e of ls(dir)) {
        if (!e.name.endsWith('.jsonl')) continue;
        const p = path.join(dir, e.name), st = statOf(p);
        if (st && (!best || st.mtimeMs > best.st.mtimeMs)) best = { p, st };
      }
      if (best) break; // 날짜 폴더는 최신순이라 처음 찾은 날이 가장 최근
    }
    if (!best) return;
    try {
      const lines = readRange(best.p, Math.max(0, best.st.size - 512 * 1024), best.st.size).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('rate_limits')) continue;
        try { const o = JSON.parse(lines[i]); if (o.payload && o.payload.rate_limits) { this.takeRate(o.payload.rate_limits, Date.parse(o.timestamp) || best.st.mtimeMs); return; } } catch { }
      }
    } catch { }
  }
  takeRate(r, at) {
    if (this.rate && this.rate.at > at) return;
    const win = (w) => {
      if (!w || typeof w.used_percent !== 'number') return null;
      const resetsAt = w.resets_at ? toMs(w.resets_at) : (typeof w.resets_in_seconds === 'number' ? at + w.resets_in_seconds * 1000 : 0);
      return { minutes: w.window_minutes || 0, used: w.used_percent, resetsAt };
    };
    this.rate = { primary: win(r.primary), secondary: win(r.secondary), plan: r.plan_type || '', at };
  }
  tick() { for (const F of this.files.values()) { try { tail(F, (F, o) => this.line(F, o)); } catch { } } }
  line(F, o) {
    const ts = Date.parse(o.timestamp) || 0, pl = o.payload || {};
    if (o.type === 'session_meta') {
      F.sid = pl.id || F.sid;
      F.child = !!(pl.parent_thread_id || (pl.source && typeof pl.source === 'object' && pl.source.subagent));
      if (!F.child && F.sid) { const S = this.sess(F); if (pl.cwd) S.cwd = pl.cwd; }
      return;
    }
    if (o.type === 'event_msg' && pl.type === 'token_count') {
      if (pl.rate_limits) this.takeRate(pl.rate_limits, ts);
      const info = pl.info; if (!info || !info.total_token_usage) return;
      const tot = info.total_token_usage;
      if (ts < this.day) F.base = tot; else F.last = tot; // 어제부터 이어진 세션은 자정 이전 누적분을 뺌
      if (!F.child && F.sid) {
        const S = this.sess(F), lt = info.last_token_usage;
        if (info.model_context_window && lt) S.ctx = Math.min(100, (lt.input_tokens || 0) / info.model_context_window * 100);
      }
      return;
    }
    if (F.child || !F.sid) return;
    const S = this.sess(F);
    if (ts) S.lastAt = Math.max(S.lastAt, ts);
    const set = (state, label) => { if (S.state !== state) S.since = ts || Date.now(); S.state = state; S.label = label; };
    if (o.type === 'turn_context') { if (pl.model) S.model = pl.model; if (pl.cwd) S.cwd = pl.cwd; return; }
    if (o.type === 'response_item') {
      if (pl.type === 'function_call' || pl.type === 'custom_tool_call' || pl.type === 'local_shell_call') set('work', codexToolLabel(pl));
      else if (pl.type === 'web_search_call') set('work', '웹 검색');
      else if (pl.type === 'reasoning') set('work', '생각 중');
      return;
    }
    if (o.type === 'event_msg') {
      const t = pl.type;
      if (t === 'task_started' || t === 'user_message') set('work', '생각 중');
      else if (t === 'agent_reasoning') set('work', '생각 중');
      else if (t === 'agent_message') set('work', '답변 쓰는 중');
      else if (t === 'exec_approval_request' || t === 'apply_patch_approval_request') set('ask', '승인 요청');
      else if (t === 'task_complete') set('wait', '답변 완료 · 다음 지시 대기');
      else if (t === 'turn_aborted') set('wait', '중단됨 · 대기');
    }
  }
  sess(F) {
    let S = this.sessions.get(F.sid);
    if (!S) { S = { id: F.sid, cwd: '', state: 'idle', label: '', lastAt: 0, since: 0, model: '', ctx: null, file: F.fp }; this.sessions.set(F.sid, S); }
    return S;
  }
  today() {
    const t = emptyTokens();
    for (const F of this.files.values()) {
      if (!F.last) continue;
      const b = F.base || {}, d = (k) => Math.max(0, (F.last[k] || 0) - (b[k] || 0));
      const cached = d('cached_input_tokens');
      t.cacheRead += cached; t.input += d('input_tokens') - cached; t.output += d('output_tokens');
    }
    t.total = t.input + t.cacheRead + t.output;
    return t;
  }
  limits(now) {
    const r = this.rate; if (!r) return null;
    const win = (w, fallback) => {
      if (!w) return null;
      const label = windowLabel(w.minutes) || fallback;
      if (w.resetsAt && w.resetsAt < now) return { label, remaining: 100, resetsAt: 0, reset: true };
      return { label, remaining: Math.max(0, Math.min(100, 100 - w.used)), resetsAt: w.resetsAt };
    };
    const windows = [win(r.primary, '5시간'), win(r.secondary, '주간')].filter(Boolean);
    return windows.length ? { windows, plan: r.plan, at: r.at } : null;
  }
  snapshot(now) {
    const list = [];
    for (const S of this.sessions.values()) {
      if (now - S.lastAt > RECENT_MS && !(S.state === 'work' && now - S.lastAt < 10 * 60e3)) continue;
      list.push(sessionView('codex', S, now, S.ctx, S.model));
    }
    return {
      installed: !!statOf(CODEX_HOME),
      limits: this.limits(now), today: this.today(),
      active: list.filter(s => s.status === 'work').length,
      sessions: list,
    };
  }
}

// ───────── 바깥에 보이는 부분 ─────────
function createCollector() {
  const claude = new Claude(), codex = new Codex();
  let lastScan = 0;
  return {
    refresh() {
      const now = Date.now();
      if (now - lastScan > 5000) { lastScan = now; claude.scan(); codex.scan(); }
      claude.tick(); codex.tick();
    },
    snapshot(claudeApiLimits) {
      const now = Date.now();
      const c = claude.snapshot(now, claudeApiLimits), x = codex.snapshot(now);
      const order = { ask: 0, work: 1, wait: 2, idle: 3 };
      const sessions = c.sessions.concat(x.sessions).sort((a, b) => (order[a.status] - order[b.status]) || (b.lastAt - a.lastAt));
      delete c.sessions; delete x.sessions;
      return { now, claude: c, codex: x, sessions };
    },
  };
}

module.exports = { createCollector, DATA_DIR, CLAUDE_DIR, CLAUDE_USAGE, prettyClaudeModel };
