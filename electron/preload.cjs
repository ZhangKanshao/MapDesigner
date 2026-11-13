const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mapAI', {
  profiles: () => ipcRenderer.invoke('ai:profiles'),
  saveProfile: draft => ipcRenderer.invoke('ai:save-profile', draft),
  activateProfile: id => ipcRenderer.invoke('ai:activate-profile', id),
  deleteProfile: id => ipcRenderer.invoke('ai:delete-profile', id),
  chat: request => ipcRenderer.invoke('ai:chat', request)
});
contextBridge.exposeInMainWorld('mapFiles', {
  switchTemplate: request => ipcRenderer.invoke('map-files:template',request),
  consumeTemplateSnapshot: () => ipcRenderer.invoke('map-files:pending-template'),
  readTemplateLookup: request => ipcRenderer.invoke('map-files:template-lookup',request),
  getDefaultSettings: () => ipcRenderer.invoke('settings:defaults'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: value => ipcRenderer.invoke('settings:save', value),
  defaults: () => ipcRenderer.invoke('map-files:defaults'),
  chooseDirectory: initial => ipcRenderer.invoke('map-files:directory', initial),
  save: request => ipcRenderer.invoke('map-files:save', request),
  openSnapshot: () => ipcRenderer.invoke('map-files:open'),
  listSnapshots: () => ipcRenderer.invoke('map-files:list'),
  readSnapshot: name => ipcRenderer.invoke('map-files:read', name),
  deleteSnapshot: name => ipcRenderer.invoke('map-files:delete', name),
  renameSnapshot: request => ipcRenderer.invoke('map-files:rename', request),
  importSnapshot: request => ipcRenderer.invoke('map-files:import', request),
  captureMap: rect => ipcRenderer.invoke('map-files:capture', rect)
});
