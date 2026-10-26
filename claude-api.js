// AI 사용량 위젯 — Claude 계정의 남은 한도를 직접 물어봄 (터미널 없이, 데스크톱 앱만 써도 보이게)
// Claude Code 에 로그인돼 있으면 그 로그인 정보(~/.claude/.credentials.json, Mac 은 키체인 'Claude Code-credentials')로
// Claude Code 의 /status 와 같은 사용량 주소에 몇 분에 한 번 물어봄. 로그인 정보는 api.anthropic.com 에만 보내고 저장하지 않음.
// 공식 문서가 없는 주소라 바뀔 수 있음 → 실패하면 상태줄(statusline.js)이 적어 둔 값으로 넘어감.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { CLAUDE_DIR } = require('./collector');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CRED_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const POLL_MS = 3 * 60e3;
const RETRY_MS = 5 * 60e3;
const KEYCHAIN_RETRY_MS = 6 * 3600e3; // 키체인을 '거부'했으면 자주 다시 묻지 않음

const WINDOWS = [['five_hour', '5시간'], ['seven_day', '주간'], ['seven_day_opus', '주간 Opus'], ['seven_day_sonnet', '주간 Sonnet']];

function parseCred(text) {
  try {
    const o = JSON.parse(text).claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return { token: o.accessToken, expiresAt: o.expiresAt || 0, plan: o.subscriptionType || '' };
  } catch { return null; }
}
function readKeychain() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 60e3 }, (err, out) => resolve(err ? null : parseCred(out)));
  });
}

class ClaudeApi {
  constructor(fetchFn) {
    this.fetch = fetchFn;
    this.enabled = true;
    this.cred = null; this.data = null; this.at = 0; this.plan = '';
    this.status = 'idle'; // idle | ok | nocred | expired | denied | error
    this.nextAt = 0; this.keychainFailedAt = 0; this.busy = false;
  }
  async credentials(force) {
    try { const c = parseCred(fs.readFileSync(CRED_FILE, 'utf8')); if (c) return c; } catch { }
    if (process.platform !== 'darwin') return null;
    if (!force && this.keychainFailedAt && Date.now() - this.keychainFailedAt < KEYCHAIN_RETRY_MS) return null;
    const c = await readKeychain();
    this.keychainFailedAt = c ? 0 : Date.now();
    return c;
  }
  async poll(force = false) {
    const now = Date.now();
    if (!this.enabled || this.busy || (!force && now < this.nextAt)) return;
    this.busy = true;
    try {
      // 토큰이 곧 만료되면 다시 읽음 (Claude Code 가 쓰면서 새로 받아 둠)
      if (force || !this.cred || (this.cred.expiresAt && this.cred.expiresAt < now + 60e3)) this.cred = await this.credentials(force);
      if (!this.cred) { this.status = process.platform === 'darwin' && this.keychainFailedAt ? 'denied' : 'nocred'; this.nextAt = now + RETRY_MS; return; }
      if (this.cred.expiresAt && this.cred.expiresAt < now) { this.status = 'expired'; this.cred = null; this.nextAt = now + RETRY_MS; return; }
      const res = await this.fetch(USAGE_URL, {
        headers: { Authorization: 'Bearer ' + this.cred.token, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json', 'User-Agent': 'ai-usage-widget' },
      });
      if (res.status === 401 || res.status === 403) { this.status = 'expired'; this.cred = null; this.nextAt = now + RETRY_MS; return; }
      if (res.status === 429) { this.nextAt = now + 2 * POLL_MS; return; }
      if (!res.ok) { this.status = 'error'; this.nextAt = now + RETRY_MS; return; }
      this.data = await res.json(); this.at = Date.now(); this.plan = this.cred.plan; this.status = 'ok';
      this.nextAt = now + POLL_MS;
    } catch {
      this.status = 'error'; this.nextAt = now + RETRY_MS;
    } finally { this.busy = false; }
  }
  // 위젯이 쓰는 모양 { windows: [{ label, remaining, resetsAt }], plan, at } — 받은 적 없으면 null
  limits(now = Date.now()) {
    if (!this.enabled || !this.data) return null;
    const windows = [];
    for (const [key, label] of WINDOWS) {
      const w = this.data[key];
      if (!w || typeof w.utilization !== 'number') continue;
      const resetsAt = w.resets_at ? Date.parse(w.resets_at) || 0 : 0;
      if (resetsAt && resetsAt < now) windows.push({ label, remaining: 100, resetsAt: 0, reset: true });
      else windows.push({ label, remaining: Math.max(0, Math.min(100, 100 - w.utilization)), resetsAt });
    }
    return windows.length ? { windows, plan: this.plan, at: this.at, source: 'api' } : null;
  }
}

module.exports = { ClaudeApi };
