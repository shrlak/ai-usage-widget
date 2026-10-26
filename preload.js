// 화면(renderer)이 쓸 수 있는 것만 좁게 열어 줌
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  onSnapshot: (fn) => ipcRenderer.on('snapshot', (_e, s) => fn(s)),
  resize: (h) => ipcRenderer.send('resize', h),
  action: (name) => ipcRenderer.send('action', name),
});
