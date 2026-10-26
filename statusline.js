#!/usr/bin/env node
// AI 사용량 위젯 — Claude Code 상태줄
// Claude Code 는 상태줄 명령에 남은 사용 한도(rate_limits)와 대화 길이(context_window)를 JSON 으로 넘겨줌.
// 그걸 claude-usage.json 에 적어 두면 위젯이 읽어 감. 원래 쓰던 상태줄이 있었다면 그대로 실행해서 그 화면을 보여줌.
// 이 파일은 위젯이 ~/.ai-usage-widget/ 에 복사해서 씀. 토큰 사용 없음.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT = path.join(__dirname, 'claude-usage.json');
const CHAIN = path.join(__dirname, 'statusline-chain.json');

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch { }
  const now = Date.now();
  const rl = d.rate_limits || {};
  const win = (w) => w && typeof w.used_percentage === 'number' ? { used: w.used_percentage, resets_at: w.resets_at || 0 } : null;
  const five = win(rl.five_hour), week = win(rl.seven_day);

  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}; } catch { }
  if (five || week) { // 첫 답장 전엔 비어 있음 → 받은 게 있을 때만 갱신
    if (five) cur.five_hour = five;
    if (week) cur.seven_day = week;
    cur.at = now;
  }
  const sessions = cur.sessions || {};
  if (d.session_id) {
    const cw = d.context_window || {};
    sessions[d.session_id] = {
      ctx: typeof cw.used_percentage === 'number' ? cw.used_percentage : undefined,
      model: (d.model && d.model.display_name) || undefined,
      cost: d.cost && typeof d.cost.total_cost_usd === 'number' ? d.cost.total_cost_usd : undefined,
      at: now,
    };
  }
  for (const k of Object.keys(sessions)) if (now - (sessions[k].at || 0) > 864e5) delete sessions[k];
  cur.sessions = sessions;
  try {
    const tmp = OUT + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cur));
    fs.renameSync(tmp, OUT); // 반쯤 쓴 파일을 위젯이 읽지 않게
  } catch { }

  // 원래 쓰던 상태줄이 있으면 그걸 그대로 보여줌
  let chain = null;
  try { chain = JSON.parse(fs.readFileSync(CHAIN, 'utf8')).statusLine; } catch { }
  if (chain && chain.command) {
    const r = spawnSync(chain.command, { input: raw, shell: true, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.stdout) { process.stdout.write(r.stdout); return; }
  }
  const pct = (w) => w ? Math.round(100 - w.used) + '%' : '-';
  const parts = [`✳ ${(d.model && d.model.display_name) || 'Claude'}`];
  if (five || week) parts.push(`남은 한도 5시간 ${pct(five)} · 주간 ${pct(week)}`);
  if (d.context_window && typeof d.context_window.used_percentage === 'number') parts.push(`대화 ${Math.round(d.context_window.used_percentage)}%`);
  process.stdout.write(parts.join('  |  '));
});
