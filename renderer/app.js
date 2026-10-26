// AI 사용량 위젯 — 화면 그리기 (1초마다 main 이 보내는 snapshot 을 그대로 그림)
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

function fmtTok(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}
function fmtLeft(ms) { // 초기화까지 남은 시간
  if (ms <= 0) return '곧';
  const m = Math.ceil(ms / 60e3);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}
function fmtReset(at, now) {
  if (!at) return '';
  const left = at - now;
  if (left < 24 * 3600e3) return `${fmtLeft(left)} 후 초기화`;
  const d = new Date(at);
  return `${DAYS[d.getDay()]}요일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 초기화 (${Math.round(left / 864e5)}일 뒤)`;
}
function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
const level = (r) => r < 10 ? 'bad' : r < 30 ? 'warn' : '';

function limitRows(lim, now) {
  return lim.windows.map((w) => {
    const r = Math.round(w.remaining);
    const sub = w.reset ? '초기화됨' : fmtReset(w.resetsAt, now);
    return `<div class="limit">
      <span class="lab">${esc(w.label)}</span>
      <div class="track"><div class="fill ${level(r)}" style="width:${r}%"></div></div>
      <span class="val">${r}%</span>
      ${sub ? `<span class="sub">${esc(sub)}</span>` : ''}
    </div>`;
  }).join('');
}

function agentBlock(name, a, now, extra) {
  const head = (tags) => `<div class="agent-head"><span class="name">${name}</span>${tags || ''}
    <span class="right">${a.active ? `작업 중 <b>${a.active}</b>` : ''}</span></div>`;
  if (!a.installed) return head() + `<div class="note">이 컴퓨터에서 ${name} 기록을 찾지 못했어요</div>`;
  let tags = '';
  if (a.limits && a.limits.plan) tags += `<span class="tag">${esc(a.limits.plan)}</span>`;
  if (a.limits && a.limits.at && now - a.limits.at > 30 * 60e3) tags += `<span class="tag" title="마지막으로 받은 한도 정보 기준">${fmtAgo(now - a.limits.at)} 전</span>`;
  let body = '';
  if (a.limits) body = `<div class="lim-title note">남은 한도</div>` + limitRows(a.limits, now);
  else body = extra || `<div class="note">한 번 대화하면 남은 한도가 표시돼요</div>`;
  const t = a.today;
  body += `<div class="today">오늘 <b>${fmtTok(t.total)}</b> 토큰 · 입력 ${fmtTok(t.input)} · 출력 ${fmtTok(t.output)}${t.cacheRead ? ` · 캐시 ${fmtTok(t.cacheRead + (t.cacheWrite || 0))}` : ''}</div>`;
  return head(tags) + body;
}

function claudeExtra(c) {
  if (c.link === 'ours') return `<div class="note">연결됐어요. Claude Code 를 다시 켜고 한 번 대화하면 남은 한도가 나와요</div>`;
  if (c.link === 'broken') return `<div class="note">~/.claude/settings.json 을 읽을 수 없어요</div>`;
  return `<div class="note">남은 한도를 보려면 Claude Code 상태줄 연결이 필요해요</div>
    <button class="link-btn" data-act="link-claude">연결하기</button>`;
}

function sessionRows(list, now) {
  if (!list.length) return `<div class="empty">지금 돌아가는 세션이 없어요</div>`;
  const MAX = 6;
  const rows = list.slice(0, MAX).map((s) => {
    const t = s.status === 'wait' || s.status === 'idle' ? `${fmtAgo(now - s.lastAt)} 전` : `${fmtAgo(now - (s.since || s.lastAt))}째`;
    const meta = [s.ctx != null ? `대화 ${s.ctx}%` : '', t].filter(Boolean).join(' · ');
    return `<div class="sess ${s.status}" title="${esc(s.model)}">
      <span class="sdot"></span>
      <span class="badge ${s.agent}">${s.agent === 'claude' ? 'C' : 'X'}</span>
      <span class="proj">${esc(s.project)}</span>
      <span class="meta">${esc(meta)}</span>
      <span class="what">${esc(s.label)}</span>
    </div>`;
  }).join('');
  return rows + (list.length > MAX ? `<div class="more">+${list.length - MAX}개 더</div>` : '');
}

function mini(s) {
  const part = (cls, letter, a) => {
    if (!a.installed) return '';
    const w = a.limits ? a.limits.windows.map(x => `${Math.round(x.remaining)}%`).join('<i>/</i>') : '<i>-</i>';
    return `<span class="${cls}"><b>${letter}</b> ${w}</span>`;
  };
  const working = s.sessions.filter(x => x.status === 'work').length;
  return part('c', 'Claude', s.claude) + part('x', 'Codex', s.codex) + (working ? `<span><i>작업</i> ${working}</span>` : '');
}

function render(s) {
  document.body.classList.toggle('collapsed', !!s.prefs.collapsed);
  $('btn-collapse').textContent = s.prefs.collapsed ? '+' : '–';
  const asking = s.sessions.some(x => x.status === 'ask'), working = s.sessions.some(x => x.status === 'work');
  $('beacon').className = 'beacon' + (asking ? ' ask' : working ? ' on' : '');
  $('mini').innerHTML = mini(s);
  if (!s.prefs.collapsed) {
    $('claude').innerHTML = agentBlock('Claude', s.claude, s.now, claudeExtra(s.claude));
    $('codex').innerHTML = agentBlock('Codex', s.codex, s.now);
    $('sessions').innerHTML = s.prefs.showSessions ? sessionRows(s.sessions, s.now) : '';
  }
}

$('btn-collapse').addEventListener('click', () => window.widget.action('toggle-collapse'));
$('btn-menu').addEventListener('click', () => window.widget.action('menu'));
document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) window.widget.action(b.dataset.act); });
document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.widget.action('menu'); });

new ResizeObserver(() => window.widget.resize($('root').getBoundingClientRect().height)).observe($('root'));
window.widget.onSnapshot(render);
