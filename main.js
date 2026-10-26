// AI 사용량 위젯 — 항상 맨 위에 떠 있는 작은 창
// 창 어디든 끌어서 옮길 수 있고, 옮긴 자리는 기억함. 트레이(메뉴 막대) 아이콘이나 ⋯ 버튼으로 설정.
'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { createCollector } = require('./collector');
const claudeLink = require('./claude-link');
const { ClaudeApi } = require('./claude-api');

const WIDTH = 300;
const SHORTCUT = 'CommandOrControl+Alt+U';
const DEFAULTS = { x: null, y: null, collapsed: false, showSessions: true, onTop: true, opacity: 1, claudeApi: true, loginSet: false };

let win = null, tray = null, prefs = { ...DEFAULTS }, collector = null;
const claudeApi = new ClaudeApi((url, opts) => net.fetch(url, opts)); // 시스템 프록시 설정을 따름
let linkState = 'none', linkCheckedAt = 0, moveTimer = null;

// ───────── 설정 저장 ─────────
const prefsFile = () => path.join(app.getPath('userData'), 'widget-settings.json');
function loadPrefs() { try { prefs = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { prefs = { ...DEFAULTS }; } }
function savePrefs() { try { fs.mkdirSync(path.dirname(prefsFile()), { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch { } }

// ───────── 창 ─────────
function defaultPos() { const a = screen.getPrimaryDisplay().workArea; return { x: a.x + a.width - WIDTH - 16, y: a.y + 16 }; }
function onSomeScreen(x, y) { // 모니터를 뺐을 때 화면 밖에 숨어 버리지 않게
  return screen.getAllDisplays().some(({ workArea: a }) => x > a.x - WIDTH + 40 && x < a.x + a.width - 40 && y >= a.y - 10 && y < a.y + a.height - 30);
}

function applyOnTop() {
  if (!win) return;
  if (prefs.onTop) {
    win.setAlwaysOnTop(true, 'screen-saver'); // 전체 화면 앱보다도 위
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false);
  }
}

function createWindow() {
  const pos = prefs.x != null && onSomeScreen(prefs.x, prefs.y) ? { x: prefs.x, y: prefs.y } : defaultPos();
  win = new BrowserWindow({
    ...pos, width: WIDTH, height: 240,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: prefs.onTop, show: false, title: 'AI 사용량',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  applyOnTop();
  win.setOpacity(prefs.opacity);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.showInactive(); push(); }); // 뜰 때 다른 앱의 입력을 뺏지 않음
  win.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { if (!win) return; const [x, y] = win.getPosition(); prefs.x = x; prefs.y = y; savePrefs(); }, 400);
  });
  win.on('blur', () => { if (prefs.onTop) applyOnTop(); }); // 다른 '항상 위' 창에 밀리지 않게 다시 올림
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function fitHeight(h) {
  if (!win) return;
  h = Math.max(36, Math.min(900, Math.ceil(h)));
  const b = win.getBounds(); if (b.height === h) return;
  const a = screen.getDisplayMatching(b).workArea;
  const y = b.y + h > a.y + a.height ? Math.max(a.y, a.y + a.height - h) : b.y; // 아래로 넘치면 위로 밀어 올림
  if (process.platform === 'linux') win.setResizable(true);
  win.setBounds({ x: b.x, y, width: WIDTH, height: h });
  if (process.platform === 'linux') win.setResizable(false);
}

function toggleVisible() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide(); else { win.showInactive(); applyOnTop(); }
  buildTray();
}

// ───────── 데이터 보내기 ─────────
function push() {
  if (!win || win.isDestroyed()) return;
  try { collector.refresh(); } catch (e) { console.error(e); }
  const now = Date.now();
  if (now - linkCheckedAt > 5000) { linkCheckedAt = now; const s = claudeLink.state(); if (s !== linkState) { linkState = s; buildTray(); } }
  claudeApi.poll().then(() => { }, () => { }); // 몇 분에 한 번만 실제로 물어봄
  const snap = collector.snapshot(claudeApi.limits(now));
  snap.claude.link = linkState;
  snap.claude.api = claudeApi.enabled ? claudeApi.status : 'off';
  snap.prefs = { collapsed: prefs.collapsed, showSessions: prefs.showSessions };
  win.webContents.send('snapshot', snap);
  if (tray) tray.setToolTip(tooltipOf(snap));
}
function tooltipOf(s) {
  const lim = (x) => x.limits ? x.limits.windows.map(w => `${w.label} ${Math.round(w.remaining)}%`).join(' · ') : '한도 정보 없음';
  return `Claude: ${lim(s.claude)}\nCodex: ${lim(s.codex)}`;
}

// ───────── Claude 한도 연결 ─────────
async function linkClaude() {
  const st = claudeLink.state();
  if (st === 'noclaude') return dialog.showMessageBox({ type: 'info', message: 'Claude Code 설정 폴더(~/.claude)를 찾지 못했어요.', detail: 'Claude Code 를 설치하고 한 번 실행한 뒤 다시 눌러 주세요.' });
  if (st === 'broken') return dialog.showMessageBox({ type: 'warning', message: '~/.claude/settings.json 을 읽을 수 없어요.', detail: 'JSON 형식이 깨져 있는 것 같아요. 파일을 고친 뒤 다시 눌러 주세요. (파일은 건드리지 않았어요)' });
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['연결하기', '취소'], defaultId: 0, cancelId: 1,
    message: 'Claude 남은 한도를 보려면 상태줄 연결이 필요해요',
    detail: 'Claude Code 는 남은 한도를 상태줄 명령에만 알려줘요.\n'
      + `${claudeLink.SETTINGS} 의 statusLine 을 위젯 것으로 바꿔요.\n`
      + `· 원래 파일은 ${path.basename(claudeLink.BACKUP)} 로 백업해요.\n`
      + (st === 'other' ? '· 쓰던 상태줄은 그대로 실행돼서 화면은 똑같이 보여요.\n' : '')
      + '· 연결 후 Claude Code 를 다시 켜고 한 번 대화하면 숫자가 나와요.\n'
      + '· 메뉴에서 언제든 해제할 수 있어요. (Node.js 가 필요해요)',
  });
  if (response !== 0) return;
  try { claudeLink.link(); } catch (e) { dialog.showErrorBox('연결하지 못했어요', String(e.message || e)); }
  linkCheckedAt = 0; push(); buildTray();
}
function unlinkClaude() {
  try { claudeLink.unlink(); } catch (e) { dialog.showErrorBox('해제하지 못했어요', String(e.message || e)); }
  linkCheckedAt = 0; push(); buildTray();
}

// ───────── 메뉴 (트레이 · ⋯ 버튼 공용) ─────────
function setPref(k, v) { prefs[k] = v; savePrefs(); buildTray(); push(); }
function menuTemplate() {
  const visible = !!(win && win.isVisible());
  const canLogin = app.isPackaged; // 개발 모드(npm start)에선 Electron 자체가 등록돼 버려서 막아 둠
  return [
    { label: visible ? '위젯 숨기기' : '위젯 보이기', accelerator: SHORTCUT, click: toggleVisible },
    { type: 'separator' },
    { label: '작게 보기', type: 'checkbox', checked: prefs.collapsed, click: (i) => setPref('collapsed', i.checked) },
    { label: '세션 목록 보이기', type: 'checkbox', checked: prefs.showSessions, click: (i) => setPref('showSessions', i.checked) },
    { label: '항상 맨 위에', type: 'checkbox', checked: prefs.onTop, click: (i) => { setPref('onTop', i.checked); applyOnTop(); } },
    { label: '투명도', submenu: [1, 0.9, 0.8, 0.7, 0.6].map(v => ({
      label: `${Math.round(v * 100)}%`, type: 'radio', checked: Math.abs(prefs.opacity - v) < 0.01,
      click: () => { setPref('opacity', v); if (win) win.setOpacity(v); },
    })) },
    { label: '위치 처음대로 (오른쪽 위)', click: () => { if (win) { const p = defaultPos(); win.setPosition(p.x, p.y); } } },
    { type: 'separator' },
    { label: 'Claude 한도를 계정에서 자동 확인', type: 'checkbox', checked: prefs.claudeApi,
      click: (i) => { claudeApi.enabled = i.checked; setPref('claudeApi', i.checked); if (i.checked) claudeApi.poll(true).then(push, push); } },
    { label: 'Claude 한도 지금 다시 확인', enabled: prefs.claudeApi, click: () => claudeApi.poll(true).then(push, push) },
    linkState === 'ours'
      ? { label: 'Claude 상태줄 연결 해제', click: unlinkClaude }
      : { label: 'Claude 상태줄로도 받기…', click: linkClaude },
    { label: '로그인할 때 자동 실행', type: 'checkbox', enabled: canLogin,
      checked: canLogin && app.getLoginItemSettings().openAtLogin,
      click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked }); buildTray(); } },
    { type: 'separator' },
    { label: '종료', role: 'quit' },
  ];
}
function trayIcon() {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
}
function buildTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('AI 사용량');
    if (process.platform === 'win32') tray.on('click', toggleVisible);
  }
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

// ───────── 화면에서 오는 요청 ─────────
ipcMain.on('resize', (_e, h) => fitHeight(Number(h) || 0));
ipcMain.on('action', (_e, name) => {
  if (name === 'toggle-collapse') setPref('collapsed', !prefs.collapsed);
  else if (name === 'menu') Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
  else if (name === 'link-claude') linkClaude();
});

// ───────── 시작 ─────────
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (!win) createWindow(); else { win.showInactive(); applyOnTop(); } });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide(); // Dock 아이콘 없이, 전체 화면 위에도 뜨게
    loadPrefs();
    claudeApi.enabled = prefs.claudeApi;
    if (app.isPackaged && !prefs.loginSet) { // 설치한 앱을 처음 켜면 로그인할 때 자동으로 뜨게 (메뉴에서 끌 수 있음)
      try { app.setLoginItemSettings({ openAtLogin: true }); } catch { }
      prefs.loginSet = true; savePrefs();
    }
    collector = createCollector();
    claudeLink.refresh();
    linkState = claudeLink.state();
    createWindow();
    buildTray();
    try { globalShortcut.register(SHORTCUT, toggleVisible); } catch { }
    setInterval(push, 1000);
    screen.on('display-removed', () => { if (win) { const [x, y] = win.getPosition(); if (!onSomeScreen(x, y)) { const p = defaultPos(); win.setPosition(p.x, p.y); } } });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { }); // 창을 닫아도 트레이에 남음 (종료는 메뉴에서)
}
