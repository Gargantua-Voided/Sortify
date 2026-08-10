import React, { useState, useEffect, useRef } from 'react';
import { Settings as SettingsIcon, ScrollText, FolderPlus, Trash2, Folder, ImagePlus, Link2, X, Palette, RefreshCw } from 'lucide-react';
import { AppSettings, CATEGORIES, LogMessage } from './types';
import logoSrc from '../logo.png';

type AppTab = 'settings' | 'icons' | 'logs';

export default function App() {
  const api = window.electronAPI || {
    getSettings: async () => ({
      autoUnzip: false,
      autoRename: true,
      autostart: false,
      launchMinimized: false,
      setCustomIcons: false,
      monitoredDirectories: [],
      scanInterval: 5,
      ignoredFileTypes: [],
      categoryIcons: {},
    }),
    saveSettings: async () => true,
    selectDirectory: async () => null,
    selectImageFile: async () => null,
    getCategories: async () => [...CATEGORIES],
    setCategoryIcon: async () => ({ category: '', settings: await (window.electronAPI as any)?.getSettings?.() }),
    clearCategoryIcon: async () => ({ category: '', settings: await (window.electronAPI as any)?.getSettings?.() }),
    setCustomIconsEnabled: async () => ({
      settings: await (window.electronAPI as any)?.getSettings?.(),
      previews: {},
    }),
    getCategoryIconPreviews: async () => ({}),
    clearExplorerIconCache: async () => ({ ok: false, message: 'Not available' }),
    onLogMessage: () => {},
    removeLogListener: () => {}
  };

  const [activeTab, setActiveTab] = useState<AppTab>('settings');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [newIgnoredType, setNewIgnoredType] = useState('');
  const [iconPreviews, setIconPreviews] = useState<Record<string, string | null>>({});
  const [urlInputs, setUrlInputs] = useState<Record<string, string>>({});
  const [iconBusy, setIconBusy] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [customIconsBusy, setCustomIconsBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load initial settings
    api.getSettings().then(setSettings);
    api.getCategoryIconPreviews().then(setIconPreviews);

    // Subscribe to logs
    api.onLogMessage((log) => {
      setLogs((prev) => [...prev, log]);
    });

    return () => {
      api.removeLogListener();
    };
  }, []);

  useEffect(() => {
    if (activeTab === 'logs') {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab]);

  const handleSaveSettings = async (newSettings: AppSettings) => {
    setSettings(newSettings);
    await api.saveSettings(newSettings);
  };

  const toggleAutoUnzip = () => {
    if (settings) {
      handleSaveSettings({ ...settings, autoUnzip: !settings.autoUnzip });
    }
  };

  const toggleAutoRename = () => {
    if (settings) {
      handleSaveSettings({ ...settings, autoRename: !settings.autoRename });
    }
  };

  const toggleAutostart = () => {
    if (settings) {
      handleSaveSettings({ ...settings, autostart: !settings.autostart });
    }
  };

  const toggleLaunchMinimized = () => {
    if (settings) {
      handleSaveSettings({ ...settings, launchMinimized: !settings.launchMinimized });
    }
  };

  const toggleSetCustomIcons = async () => {
    if (!settings || customIconsBusy || !api.setCustomIconsEnabled) return;
    const next = !settings.setCustomIcons;
    setCustomIconsBusy(true);
    setIconError(null);
    try {
      const result = await api.setCustomIconsEnabled(next);
      setSettings(result.settings);
      setIconPreviews(result.previews);
      if (!next && activeTab === 'icons') {
        setActiveTab('settings');
      }
    } catch (err) {
      setIconError(err instanceof Error ? err.message : String(err));
      // Resync — main may have rolled back after a failed apply.
      try {
        const [synced, previews] = await Promise.all([
          api.getSettings(),
          api.getCategoryIconPreviews(),
        ]);
        setSettings(synced);
        setIconPreviews(previews);
      } catch {
        // ignore
      }
    } finally {
      setCustomIconsBusy(false);
    }
  };

  const handleAddDirectory = async () => {
    if (settings) {
      const dir = await api.selectDirectory();
      if (dir && !settings.monitoredDirectories.includes(dir)) {
        handleSaveSettings({
          ...settings,
          monitoredDirectories: [...settings.monitoredDirectories, dir],
        });
      }
    }
  };

  const handleRemoveDirectory = (dirToRemove: string) => {
    if (settings) {
      handleSaveSettings({
        ...settings,
        monitoredDirectories: settings.monitoredDirectories.filter((d) => d !== dirToRemove),
      });
    }
  };

  const handleAddIgnoredType = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && newIgnoredType.trim()) {
      let ext = newIgnoredType.trim().toLowerCase();
      if (!ext.startsWith('.')) ext = '.' + ext;
      
      if (settings && !settings.ignoredFileTypes.includes(ext)) {
        handleSaveSettings({
          ...settings,
          ignoredFileTypes: [...settings.ignoredFileTypes, ext]
        });
        setNewIgnoredType('');
      }
    }
  };

  const removeIgnoredType = (ext: string) => {
    if (settings) {
      handleSaveSettings({
        ...settings,
        ignoredFileTypes: settings.ignoredFileTypes.filter((e) => e !== ext)
      });
    }
  };

  const handleScanIntervalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    if (!isNaN(val) && val > 0 && settings) {
      handleSaveSettings({ ...settings, scanInterval: val });
    }
  };

  const handleBrowseCategoryIcon = async (category: string) => {
    if (!api.selectImageFile || !api.setCategoryIcon) return;
    setIconError(null);
    const filePath = await api.selectImageFile();
    if (!filePath) return;

    setIconBusy(category);
    try {
      const result = await api.setCategoryIcon({
        category,
        sourceType: 'file',
        value: filePath,
      });
      setSettings(result.settings);
      setIconPreviews((prev) => ({
        ...prev,
        [category]: result.previewDataUrl ?? null,
      }));
    } catch (err) {
      setIconError(err instanceof Error ? err.message : String(err));
    } finally {
      setIconBusy(null);
    }
  };

  const handleUrlCategoryIcon = async (category: string) => {
    if (!api.setCategoryIcon) return;
    const url = (urlInputs[category] || '').trim();
    if (!url) {
      setIconError('Enter an image URL first');
      return;
    }

    setIconError(null);
    setIconBusy(category);
    try {
      const result = await api.setCategoryIcon({
        category,
        sourceType: 'url',
        value: url,
      });
      setSettings(result.settings);
      setIconPreviews((prev) => ({
        ...prev,
        [category]: result.previewDataUrl ?? null,
      }));
      setUrlInputs((prev) => ({ ...prev, [category]: '' }));
    } catch (err) {
      setIconError(err instanceof Error ? err.message : String(err));
    } finally {
      setIconBusy(null);
    }
  };

  const handleClearCategoryIcon = async (category: string) => {
    if (!api.clearCategoryIcon) return;
    setIconError(null);
    setIconBusy(category);
    try {
      const result = await api.clearCategoryIcon(category);
      setSettings(result.settings);
      setIconPreviews((prev) => ({ ...prev, [category]: null }));
    } catch (err) {
      setIconError(err instanceof Error ? err.message : String(err));
    } finally {
      setIconBusy(null);
    }
  };

  const handleClearExplorerIconCache = async () => {
    if (!api.clearExplorerIconCache || cacheBusy) return;
    setCacheBusy(true);
    setCacheStatus(null);
    try {
      const result = await api.clearExplorerIconCache();
      setCacheStatus(result.ok ? result.message : `Error: ${result.message}`);
    } catch (err) {
      setCacheStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setCacheBusy(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0a0c10] text-slate-400 font-sans">
        Initializing Sortify Engine...
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-[#0a0c10] text-slate-300 font-sans overflow-hidden select-none">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-[#0d1117] border-r border-slate-800 flex flex-col justify-between shrink-0">
        <div className="p-6 flex-1 flex flex-col">
          <div className="flex items-center gap-3 mb-10">
            <img src={logoSrc} alt="Sortify Logo" className="w-10 h-10 object-contain drop-shadow-[0_0_15px_rgba(14,165,233,0.3)]" />
            <h1 className="text-xl font-bold tracking-tight text-white">Sortify <span className="text-sky-500 font-mono text-xs align-top font-normal">v1.0</span></h1>
          </div>
          
          <nav className="space-y-1">
            <button
              onClick={() => setActiveTab('settings')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${
                activeTab === 'settings' 
                  ? 'bg-slate-800 text-sky-400' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <SettingsIcon className="w-4 h-4" />
              Settings
            </button>
            <button
              onClick={() => {
                if (!settings.setCustomIcons) return;
                setActiveTab('icons');
              }}
              disabled={!settings.setCustomIcons}
              title={
                settings.setCustomIcons
                  ? 'Customize category folder icons'
                  : 'Enable Set Custom Icons in Settings first'
              }
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${
                !settings.setCustomIcons
                  ? 'text-slate-600 cursor-not-allowed opacity-45'
                  : activeTab === 'icons'
                    ? 'bg-slate-800 text-sky-400'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Palette className="w-4 h-4" />
              Custom Icons
            </button>
            <button
              onClick={() => setActiveTab('logs')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors ${
                activeTab === 'logs' 
                  ? 'bg-slate-800 text-sky-400' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <ScrollText className="w-4 h-4" />
              Activity Logs
            </button>
          </nav>
        </div>
        
        <div className="p-6 border-t border-slate-800 bg-slate-900/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-500 uppercase font-bold tracking-widest">Engine Status</span>
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
          </div>
          <p className="text-sm text-slate-400">Listening in System Tray</p>
        </div>
      </aside>

      {/* Main Content View */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Windows Title Bar */}
        <header className="h-10 flex items-center justify-between px-4 bg-[#0d1117] border-b border-slate-800 shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
          <div className="text-xs text-slate-500 font-medium">Sortify Desktop Manager</div>
          <div className="flex items-center h-full -mr-4" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button onClick={() => window.electronAPI?.windowControl?.('minimize')} className="h-full px-4 hover:bg-slate-800 flex items-center"><div className="w-3 h-0.5 bg-slate-400"></div></button>
            <button onClick={() => window.electronAPI?.windowControl?.('maximize')} className="h-full px-4 hover:bg-slate-800 flex items-center"><div className="w-3 h-3 border border-slate-400"></div></button>
            <button onClick={() => window.electronAPI?.windowControl?.('close')} className="h-full px-4 hover:bg-red-500 hover:text-white text-slate-400 transition-colors flex items-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </header>

        {/* Page Body */}
        <div className="p-8 flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 w-full max-w-5xl mx-auto">
          {activeTab === 'settings' && (
            <>
              <div className="shrink-0 mb-2">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-2xl font-bold tracking-tight text-white">Application Settings</h2>
                    <p className="text-slate-400 mt-1 text-sm">Configure how files are sorted and managed on your system.</p>
                  </div>
                  <button
                    onClick={handleClearExplorerIconCache}
                    disabled={cacheBusy}
                    title="Delete Windows Explorer icon cache and restart Explorer"
                    className="shrink-0 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 transition-colors disabled:opacity-50 flex items-center gap-2 self-start"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${cacheBusy ? 'animate-spin' : ''}`} />
                    {cacheBusy ? 'Clearing…' : 'Clear Explorer Icon Cache'}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 mt-2">
                  If folder icons stick on the Windows default, clear the Explorer icon cache. The desktop may flicker briefly while Explorer restarts.
                </p>
                {cacheStatus && (
                  <p className={`text-sm mt-2 ${cacheStatus.toLowerCase().includes('fail') ? 'text-red-400' : 'text-emerald-400'}`}>
                    {cacheStatus}
                  </p>
                )}
              </div>

              <div className="flex flex-col md:flex-row gap-6 flex-1 min-h-[320px]">
                {/* General Options */}
                <div className="md:w-1/3 flex flex-col gap-6 shrink-0 overflow-y-auto pr-2">
                  <div className="bg-[#161b22] p-5 rounded-xl border border-slate-800 shrink-0">
                    <h3 className="font-semibold text-white mb-4">Quick Config</h3>
                    <div className="space-y-5">
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-400 flex-1 pr-4">Auto Unzip Archives</label>
                        <div 
                          className={`w-10 h-5 rounded-full flex items-center px-1 relative cursor-pointer transition-colors ${settings.autoUnzip ? 'bg-sky-600' : 'bg-slate-700'}`}
                          onClick={toggleAutoUnzip}
                        >
                          <div className={`w-3 h-3 bg-white rounded-full transition-all ${settings.autoUnzip ? 'ml-auto' : 'bg-slate-400'}`}></div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-400 flex-1 pr-4">Auto Renaming</label>
                        <div
                          className={`w-10 h-5 rounded-full flex items-center px-1 relative cursor-pointer transition-colors ${settings.autoRename ? 'bg-sky-600' : 'bg-slate-700'}`}
                          onClick={toggleAutoRename}
                        >
                          <div className={`w-3 h-3 bg-white rounded-full transition-all ${settings.autoRename ? 'ml-auto' : 'bg-slate-400'}`}></div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-400 flex-1 pr-4">Launch on Boot</label>
                        <div 
                          className={`w-10 h-5 rounded-full flex items-center px-1 relative cursor-pointer transition-colors ${settings.autostart ? 'bg-sky-600' : 'bg-slate-700'}`}
                          onClick={toggleAutostart}
                        >
                          <div className={`w-3 h-3 bg-white rounded-full transition-all ${settings.autostart ? 'ml-auto' : 'bg-slate-400'}`}></div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-400 flex-1 pr-4">Launch Minimized</label>
                        <div 
                          className={`w-10 h-5 rounded-full flex items-center px-1 relative cursor-pointer transition-colors ${settings.launchMinimized ? 'bg-sky-600' : 'bg-slate-700'}`}
                          onClick={toggleLaunchMinimized}
                        >
                          <div className={`w-3 h-3 bg-white rounded-full transition-all ${settings.launchMinimized ? 'ml-auto' : 'bg-slate-400'}`}></div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-400 flex-1 pr-4">
                          Set Custom Icons
                          {customIconsBusy && (
                            <span className="block text-[11px] text-slate-500 mt-0.5">Applying…</span>
                          )}
                        </label>
                        <div
                          className={`w-10 h-5 rounded-full flex items-center px-1 relative transition-colors ${
                            customIconsBusy ? 'opacity-50 cursor-wait' : 'cursor-pointer'
                          } ${settings.setCustomIcons ? 'bg-sky-600' : 'bg-slate-700'}`}
                          onClick={toggleSetCustomIcons}
                        >
                          <div className={`w-3 h-3 bg-white rounded-full transition-all ${settings.setCustomIcons ? 'ml-auto' : 'bg-slate-400'}`}></div>
                        </div>
                      </div>
                      
                      <div className="pt-4 mt-2 border-t border-slate-800">
                        <label className="text-sm text-slate-400 block mb-2">Scan Interval (seconds)</label>
                        <input 
                          type="number" 
                          min="1"
                          value={settings.scanInterval} 
                          onChange={handleScanIntervalChange}
                          className="w-full bg-[#0d1117] border border-slate-700 text-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-500 transition-colors"
                        />
                      </div>
                      
                      <div className="pt-2">
                        <label className="text-sm text-slate-400 block mb-2">Ignored Types</label>
                        <input 
                          type="text" 
                          placeholder="Add extension & press Enter (e.g. .tmp)"
                          value={newIgnoredType}
                          onChange={(e) => setNewIgnoredType(e.target.value)}
                          onKeyDown={handleAddIgnoredType}
                          className="w-full bg-[#0d1117] border border-slate-700 text-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-sky-500 transition-colors mb-2"
                        />
                        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                          {settings.ignoredFileTypes.map(ext => (
                            <span key={ext} className="inline-flex items-center gap-1 px-2 py-1 bg-slate-800 text-slate-300 text-xs rounded border border-slate-700">
                              {ext}
                              <button onClick={() => removeIgnoredType(ext)} className="text-slate-500 hover:text-red-400 focus:outline-none">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Monitored Directories */}
                <div className="bg-[#161b22] flex-1 rounded-xl border border-slate-800 flex flex-col overflow-hidden min-h-[300px]">
                  <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/40 shrink-0">
                    <h2 className="font-semibold text-white">Monitored Directories</h2>
                    <button 
                      onClick={handleAddDirectory}
                      className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs rounded font-medium transition-colors flex items-center gap-1.5"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      Add Directory
                    </button>
                  </div>
                  <div className="flex-1 overflow-auto">
                    {settings.monitoredDirectories.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-slate-500 p-8">
                        <Folder className="w-12 h-12 text-slate-700 mb-3" strokeWidth={1} />
                        <p className="text-sm font-medium text-slate-300">No directories monitored</p>
                        <p className="text-xs mt-1">Add a folder to start automatically sorting files.</p>
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse">
                        <thead className="sticky top-0 bg-[#161b22] z-10">
                          <tr className="text-xs text-slate-500 border-b border-slate-800 bg-slate-900/20">
                            <th className="p-4 font-medium w-full">PATH</th>
                            <th className="p-4 font-medium text-center">STATUS</th>
                            <th className="p-4 font-medium text-right">ACTION</th>
                          </tr>
                        </thead>
                        <tbody className="text-xs">
                          {settings.monitoredDirectories.map((dir, idx) => (
                            <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors group">
                              <td className="p-4 text-slate-300 font-medium">
                                <div className="flex items-center gap-2">
                                  <Folder className="w-4 h-4 text-slate-500 shrink-0" />
                                  <span className="truncate max-w-[200px] sm:max-w-[300px]" title={dir}>{dir}</span>
                                </div>
                              </td>
                              <td className="p-4 text-center">
                                <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-500 rounded-full inline-block">Active</span>
                              </td>
                              <td className="p-4 text-right">
                                <button 
                                  onClick={() => handleRemoveDirectory(dir)}
                                  className="text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                                  title="Remove directory"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'icons' && settings.setCustomIcons && (
            <>
              <div className="shrink-0 mb-2">
                <h2 className="text-2xl font-bold tracking-tight text-white">Custom Icons</h2>
                <p className="text-slate-400 mt-1 text-sm">
                  Enabling Set Custom Icons applies category icons and Default.png to existing top-level folders in monitored directories (not nested). Browse a local image or paste a URL to override any category — Sortify converts it to .ico automatically.
                </p>
                {iconError && (
                  <p className="text-sm text-red-400 mt-3">{iconError}</p>
                )}
              </div>

              <div className="bg-[#161b22] rounded-xl border border-slate-800 flex flex-col overflow-hidden flex-1 min-h-0">
                <div className="overflow-y-auto p-4 space-y-3 flex-1">
                  {CATEGORIES.map((category) => {
                    const preview = iconPreviews[category];
                    const busy = iconBusy === category;
                    return (
                      <div
                        key={category}
                        className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg bg-[#0d1117]/40 border border-slate-800/80"
                      >
                        <div className="flex items-center gap-3 sm:w-44 shrink-0">
                          <div className="w-11 h-11 rounded-md bg-slate-800 border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
                            {preview ? (
                              <img src={preview} alt={`${category} icon`} className="w-8 h-8 object-contain" />
                            ) : (
                              <Folder className="w-5 h-5 text-slate-600" />
                            )}
                          </div>
                          <div>
                            <span className="text-sm text-slate-200 font-medium block">{category}</span>
                            <span className="text-[11px] text-slate-500">
                              {preview ? 'Custom icon set' : 'Default folder icon'}
                            </span>
                          </div>
                        </div>

                        <div className="flex-1 flex flex-col sm:flex-row gap-2 min-w-0">
                          <input
                            type="url"
                            placeholder="https://... image URL"
                            value={urlInputs[category] || ''}
                            onChange={(e) =>
                              setUrlInputs((prev) => ({ ...prev, [category]: e.target.value }))
                            }
                            disabled={busy}
                            className="flex-1 min-w-0 bg-[#0d1117] border border-slate-700 text-slate-300 rounded px-3 py-1.5 text-xs focus:outline-none focus:border-sky-500 transition-colors disabled:opacity-50"
                          />
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => handleUrlCategoryIcon(category)}
                              disabled={busy}
                              title="Load from URL"
                              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded border border-slate-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                            >
                              <Link2 className="w-3.5 h-3.5" />
                              URL
                            </button>
                            <button
                              onClick={() => handleBrowseCategoryIcon(category)}
                              disabled={busy}
                              title="Browse image from disk"
                              className="px-2.5 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                            >
                              <ImagePlus className="w-3.5 h-3.5" />
                              Browse
                            </button>
                            {preview && (
                              <button
                                onClick={() => handleClearCategoryIcon(category)}
                                disabled={busy}
                                title="Clear custom icon"
                                className="px-2 py-1.5 text-slate-500 hover:text-red-400 hover:bg-slate-800 rounded transition-colors disabled:opacity-50"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {activeTab === 'logs' && (
            <div className="flex-1 flex flex-col bg-black/40 rounded-xl border border-slate-800 overflow-hidden font-mono text-[12px] shadow-inner h-full">
              <div className="bg-slate-900/80 p-3 border-b border-slate-800 flex items-center justify-between shrink-0">
                <span className="text-slate-500 uppercase font-bold tracking-wider text-[10px]">Real-time Log</span>
                <span className="text-slate-600 text-[10px]">[UTF-8]</span>
              </div>
              <div className="p-4 space-y-1.5 overflow-y-auto flex-1">
                {logs.length === 0 ? (
                  <div className="text-slate-600 italic">Waiting for file activity...</div>
                ) : (
                  <>
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-3 hover:bg-white/5 px-2 py-1 -mx-2 rounded transition-colors">
                        <span className="text-slate-500 shrink-0">
                          [{new Date(log.timestamp).toLocaleTimeString()}]
                        </span>
                        <span className={`${
                          log.message.includes('Error') ? 'text-red-400' :
                          log.message.includes('Started') ? 'text-emerald-400' :
                          log.message.includes('Successfully') ? 'text-sky-400' :
                          log.message.includes('Unzipping') ? 'text-orange-400' :
                          'text-slate-300'
                        }`}>
                          {log.message.includes('Error') && <span className="text-red-400 font-bold">ERROR: </span>}
                          {log.message.includes('Started') && <span className="text-emerald-400 font-bold">INFO: </span>}
                          {log.message.includes('Moved') && <span className="text-sky-400 font-bold">MOVE: </span>}
                          {log.message.includes('Successfully unzipped') && <span className="text-sky-400 font-bold">UNZIP: </span>}
                          {log.message.replace(/^(Error|Started|Moved|Successfully unzipped)/, '')}
                        </span>
                      </div>
                    ))}
                    <div ref={logsEndRef} />
                  </>
                )}
                <div className="text-slate-600 animate-pulse mt-2">_</div>
              </div>
            </div>
          )}
        </div>

        {/* Status Bar */}
        <footer className="h-6 bg-sky-600 flex items-center px-4 justify-between text-[10px] text-sky-50 font-medium uppercase tracking-tight shrink-0">
          <div className="flex items-center gap-4">
            <span>System: Windows</span>
            <span className="opacity-70">|</span>
            <span>Engine: Active</span>
          </div>
          <div className="flex items-center gap-3">
            <span>Tray Icon Enabled</span>
            <div className="w-2 h-2 bg-white rounded-full"></div>
          </div>
        </footer>
      </main>
    </div>
  );
}
