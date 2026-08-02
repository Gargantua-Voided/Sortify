import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectImageFile: () => ipcRenderer.invoke('select-image-file'),
  getCategories: () => ipcRenderer.invoke('get-categories'),
  setCategoryIcon: (payload: { category: string; sourceType: 'file' | 'url'; value: string }) =>
    ipcRenderer.invoke('set-category-icon', payload),
  clearCategoryIcon: (category: string) => ipcRenderer.invoke('clear-category-icon', category),
  setCustomIconsEnabled: (enabled: boolean) => ipcRenderer.invoke('set-custom-icons-enabled', enabled),
  getCategoryIconPreviews: () => ipcRenderer.invoke('get-category-icon-previews'),
  clearExplorerIconCache: () => ipcRenderer.invoke('clear-explorer-icon-cache'),
  onLogMessage: (callback: (data: {timestamp: string, message: string}) => void) => {
    ipcRenderer.on('log-message', (_event, data) => callback(data));
  },
  removeLogListener: () => {
    ipcRenderer.removeAllListeners('log-message');
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.send('window-control', action)
});
