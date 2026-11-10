const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tool: (name, args) => ipcRenderer.invoke('tool', name, args),
  native: (name, args) => ipcRenderer.invoke('native', name, args),
  workerNext: () => ipcRenderer.invoke('worker:next'),
  workerDone: (id, result) => ipcRenderer.invoke('worker:done', id, result),
  drag: (ids) => ipcRenderer.send('drag', ids),
  pathOf: (file) => webUtils.getPathForFile(file),
  on: (channel, fn) => {
    if (!['files-updated', 'scan', 'imported', 'worker-wake'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
