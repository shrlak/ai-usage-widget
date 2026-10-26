// AI 사용량 위젯 — Claude Code 상태줄 연결/해제
// Claude 의 남은 한도는 기록 파일에 없고 상태줄 명령에만 넘어옴 → ~/.claude/settings.json 의 statusLine 을 위젯 것으로.
// 원래 상태줄이 있었으면 statusline-chain.json 에 적어 두고 위젯 상태줄이 대신 실행해 줌 (화면은 그대로).
'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CLAUDE_DIR } = require('./collector');

const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const BACKUP = SETTINGS + '.before-ai-usage-widget';
const SL_SRC = path.join(__dirname, 'statusline.js');
const SL_DST = path.join(DATA_DIR, 'statusline.js');
const CHAIN = path.join(DATA_DIR, 'statusline-chain.json');
const OUR_CMD = `node "${SL_DST.replace(/\\/g, '/')}"`;

const isOurs = (sl) => !!(sl && String(sl.command || '').includes('.ai-usage-widget'));

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function writeSettings(j) {
  const tmp = SETTINGS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}
function installScript() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 앱 묶음(asar) 안에서도 읽히도록 내용으로 복사
  fs.writeFileSync(SL_DST, fs.readFileSync(SL_SRC, 'utf8'));
}

// 'noclaude' | 'none' | 'ours' | 'other' | 'broken'
function state() {
  if (!fs.existsSync(CLAUDE_DIR)) return 'noclaude';
  let j; try { j = readSettings(); } catch { return 'broken'; }
  if (!j.statusLine) return 'none';
  return isOurs(j.statusLine) ? 'ours' : 'other';
}

function link() {
  const j = readSettings(); // 깨진 JSON 이면 여기서 멈춤 (덮어쓰지 않음)
  installScript();
  if (isOurs(j.statusLine)) return 'ours';
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS) && !fs.existsSync(BACKUP)) fs.copyFileSync(SETTINGS, BACKUP);
  if (j.statusLine) fs.writeFileSync(CHAIN, JSON.stringify({ statusLine: j.statusLine }, null, 2));
  else { try { fs.unlinkSync(CHAIN); } catch { } }
  j.statusLine = { type: 'command', command: OUR_CMD };
  writeSettings(j);
  return 'ours';
}

function unlink() {
  const j = readSettings();
  if (!isOurs(j.statusLine)) return state();
  let prev = null; try { prev = JSON.parse(fs.readFileSync(CHAIN, 'utf8')).statusLine; } catch { }
  if (prev) j.statusLine = prev; else delete j.statusLine;
  writeSettings(j);
  try { fs.unlinkSync(CHAIN); } catch { }
  return state();
}

// 앱을 새 버전으로 바꿨을 때 복사본도 최신으로
function refresh() { if (state() === 'ours') { try { installScript(); } catch { } } }

module.exports = { state, link, unlink, refresh, SETTINGS, BACKUP };
