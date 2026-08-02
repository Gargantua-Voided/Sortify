import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import chokidar from 'chokidar';
import AdmZip from 'adm-zip';
import {
  CATEGORIES,
  applyBundledDefaultCategoryIcons,
  applyCategoryIconToMonitoredDirs,
  applyGenericDefaultIconToTopLevelFolders,
  clearAllCategoryIcons,
  convertSourceToCategoryIco,
  ensureCategoryFolderIcon,
  getCategoryIconPath,
  getGenericDefaultIconPath,
  iconFileToDataUrl,
  isSortifyFolderMetaFile,
} from './categoryIcons';

// CommonJS equivalent for __dirname since we might build to CJS or ESM,
// but since esbuild outputs CJS, we can just use __dirname.
// Wait, esbuild with format=cjs wraps it, but just in case:
const __dirname_mapped = __dirname;

const AUTOSTART_NAME = 'Sortify';
const AUTOSTART_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: chokidar.FSWatcher | null = null;
let isQuitting = false;

// Settings structure
interface AppSettings {
  autoUnzip: boolean;
  autoRename: boolean;
  autostart: boolean;
  launchMinimized: boolean;
  /** When false, folder icons stay Windows-default and Custom Icons UI is locked. */
  setCustomIcons: boolean;
  monitoredDirectories: string[];
  scanInterval: number;
  ignoredFileTypes: string[];
  /** Absolute paths to per-category .ico files in userData */
  categoryIcons: Record<string, string>;
}

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let currentSettings: AppSettings = {
  autoUnzip: false,
  autoRename: true,
  autostart: true,
  launchMinimized: false,
  setCustomIcons: false,
  monitoredDirectories: [],
  scanInterval: 5,
  ignoredFileTypes: ['.tmp', '.crdownload', '.part', '.ini'],
  categoryIcons: {},
};

function shouldStartHidden(): boolean {
  // Boot / shortcut args take priority; otherwise honor the setting for every startup.
  if (process.argv.includes('--hidden') || process.argv.includes('--minimized')) {
    return true;
  }
  return currentSettings.launchMinimized;
}

function getStartupShortcutPath(): string {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    `${AUTOSTART_NAME}.lnk`
  );
}

/** Remove leftover HKCU Run entries from the old autostart implementation. */
function removeLegacyRunAutostart() {
  if (process.platform !== 'win32') return;

  try {
    app.setLoginItemSettings({
      openAtLogin: false,
      name: AUTOSTART_NAME,
      path: process.execPath,
    });
  } catch {
    // ignore
  }

  for (const key of [AUTOSTART_REG_KEY, AUTOSTART_APPROVED_KEY]) {
    try {
      execFileSync('reg', ['delete', key, '/v', AUTOSTART_NAME, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Value may not exist — that's fine.
    }
  }
}

function removeStartupShortcut() {
  const shortcutPath = getStartupShortcutPath();
  try {
    if (fs.existsSync(shortcutPath)) {
      fs.unlinkSync(shortcutPath);
    }
  } catch (err) {
    console.error('Failed to remove Startup shortcut:', err);
  }
}

/**
 * Prefer a Startup-folder .lnk on Windows. Run-key / setLoginItemSettings
 * often show up in Task Manager on Win11 but never actually launch (StartupApproved
 * disable blobs, quoting races, Fast Startup edge cases). A shell:Startup shortcut
 * is simpler and more reliable for tray apps.
 */
function applyAutostartSettings() {
  if (!app.isPackaged) return;

  if (process.platform === 'win32') {
    // Always drop the old registry approach so we don't double-start or keep a dead entry.
    removeLegacyRunAutostart();

    try {
      if (currentSettings.autostart) {
        const shortcutPath = getStartupShortcutPath();
        const args = currentSettings.launchMinimized ? '--hidden' : '';
        const workingDir = path.dirname(process.execPath);
        // PowerShell + WScript.Shell is the no-deps way to write a proper .lnk
        const script = [
          `$ws = New-Object -ComObject WScript.Shell`,
          `$s = $ws.CreateShortcut(${JSON.stringify(shortcutPath)})`,
          `$s.TargetPath = ${JSON.stringify(process.execPath)}`,
          `$s.Arguments = ${JSON.stringify(args)}`,
          `$s.WorkingDirectory = ${JSON.stringify(workingDir)}`,
          `$s.Description = ${JSON.stringify(AUTOSTART_NAME)}`,
          `$s.Save()`,
        ].join('; ');

        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
          { stdio: 'ignore', windowsHide: true }
        );
      } else {
        removeStartupShortcut();
      }
    } catch (err) {
      console.error('Failed to update Windows Startup shortcut:', err);
    }
    return;
  }

  // Non-Windows: Electron's login-item API is fine.
  try {
    app.setLoginItemSettings({
      openAtLogin: currentSettings.autostart,
      openAsHidden: currentSettings.launchMinimized,
      args: currentSettings.launchMinimized ? ['--hidden'] : [],
    });
  } catch (err) {
    console.error('setLoginItemSettings failed:', err);
  }
}

// Load settings
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      currentSettings = {
        ...currentSettings,
        ...parsed,
        categoryIcons: { ...currentSettings.categoryIcons, ...(parsed.categoryIcons || {}) },
      };

      // Migrate older installs that already had custom icons before this flag existed.
      if (parsed.setCustomIcons === undefined) {
        currentSettings.setCustomIcons =
          Object.keys(currentSettings.categoryIcons).length > 0;
      }
    }

    // Autostart is applied after the window opens (see whenReady) so PowerShell
    // shortcut work doesn't block first paint. Still applied on saveSettings().
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

function getCategoryIconPreviews(): Record<string, string | null> {
  const previews: Record<string, string | null> = {};
  for (const category of CATEGORIES) {
    const icoPath = currentSettings.categoryIcons[category];
    previews[category] = icoPath ? iconFileToDataUrl(icoPath) : null;
  }
  return previews;
}

// Save settings
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf-8');
    applyAutostartSettings();
  } catch (err) {
    console.error('Error saving settings:', err);
  }
}

function sendLog(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', { timestamp, message });
  }
}

function getCategoryForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.jpg': case '.jpeg': case '.png': case '.gif': case '.webp': case '.bmp':
      return 'Images';
    case '.mp4': case '.mkv': case '.avi': case '.mov':
      return 'Videos';
    case '.mp3': case '.wav': case '.flac': case '.aac':
      return 'Audio';
    case '.pdf': case '.doc': case '.docx': case '.txt': case '.rtf': case '.odt':
      return 'Documents';
    case '.zip': case '.rar': case '.7z': case '.tar': case '.gz':
      return 'Archives';
    case '.exe': case '.msi': case '.apk': case '.app':
      return 'Executables';
    default:
      return 'Others';
  }
}

async function processFile(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return;

    const dir = path.dirname(filePath);
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();

    if (isSortifyFolderMetaFile(filePath)) {
      return;
    }

    if (currentSettings.ignoredFileTypes.includes(ext)) {
      return;
    }

    // Auto unzip
    if (currentSettings.autoUnzip && (ext === '.zip')) {
      sendLog(`Unzipping ${filename}...`);
      try {
        const zip = new AdmZip(filePath);
        const extractPath = path.join(dir, filename.replace('.zip', ''));
        zip.extractAllTo(extractPath, true);
        sendLog(`Successfully unzipped ${filename} to ${extractPath}`);
        // Optionally delete the zip after extracting
        // fs.unlinkSync(filePath);
        return; // Don't sort the zip file if we unzipped it (or maybe sort it later)
      } catch (e) {
        sendLog(`Error unzipping ${filename}: ${String(e)}`);
      }
    }

    // Sort into folder
    const category = getCategoryForFile(filename);
    const targetDir = path.join(dir, category);

    const createdFolder = !fs.existsSync(targetDir);
    if (createdFolder) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Apply custom category icon (new folders, and re-assert on existing ones)
    if (currentSettings.setCustomIcons) {
      ensureCategoryFolderIcon(targetDir, category, currentSettings.categoryIcons);
    }

    let targetPath = path.join(targetDir, filename);

    // Avoid moving if it's already there
    if (filePath === targetPath) return;

    if (fs.existsSync(targetPath)) {
      if (!currentSettings.autoRename) {
        sendLog(`Skipped ${filename}: already exists in ${category}`);
        return;
      }
      targetPath = getUniqueTargetPath(targetDir, filename);
    }

    // simple rename (might fail across partitions, but okay for same dir)
    fs.renameSync(filePath, targetPath);
    const movedName = path.basename(targetPath);
    if (movedName !== filename) {
      sendLog(`Moved ${filename} → ${category}/${movedName} (renamed)`);
    } else {
      sendLog(`Moved ${filename} to ${category} folder`);
    }

  } catch (error) {
    sendLog(`Error processing ${filePath}: ${String(error)}`);
  }
}

/** photo.jpg → photo (1).jpg, photo (2).jpg, … until free */
function getUniqueTargetPath(targetDir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let n = 1;
  while (n < 10000) {
    const candidate = path.join(targetDir, `${base} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    n++;
  }
  // Extremely unlikely fallback
  return path.join(targetDir, `${base} (${Date.now()})${ext}`);
}

function setupWatcher() {
  if (watcher) {
    watcher.close();
  }
  
  if (currentSettings.monitoredDirectories.length === 0) return;

  watcher = chokidar.watch(currentSettings.monitoredDirectories, {
    ignored: (filePath: string) => {
      // ignore Sortify folder icon metadata
      if (isSortifyFolderMetaFile(filePath)) return true;
      // ignore dotfiles
      if (/(^|[\/\\])\../.test(filePath)) return true;
      // ignore by extension
      const ext = path.extname(filePath).toLowerCase();
      if (currentSettings.ignoredFileTypes.includes(ext)) return true;
      return false;
    },
    persistent: true,
    depth: 0, // only monitor the root of the directory, not subdirectories recursively
    usePolling: true,
    interval: currentSettings.scanInterval * 1000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    // Only process files in the direct monitored directories to avoid loops
    const dir = path.dirname(filePath);
    if (currentSettings.monitoredDirectories.includes(dir)) {
      sendLog(`Detected new file: ${filePath}`);
      processFile(filePath);
    }
  });

  sendLog(`Started monitoring ${currentSettings.monitoredDirectories.length} directories`);
}

function getAppLogoPath() {
  return path.join(__dirname_mapped, '../logo.png');
}

/**
 * Auto-build a small tray icon from root logo.png and cache it in userData.
 * Don't ship a separate tray asset — one logo.png is the source of truth.
 */
function getTrayIcon() {
  const logoPath = getAppLogoPath();
  const size = process.platform === 'win32' ? 64 : 22;
  const cachePath = path.join(app.getPath('userData'), `tray-icon-${size}.png`);

  try {
    if (fs.existsSync(cachePath) && fs.existsSync(logoPath)) {
      const cacheStat = fs.statSync(cachePath);
      const logoStat = fs.statSync(logoPath);
      if (cacheStat.mtimeMs >= logoStat.mtimeMs) {
        const cached = nativeImage.createFromPath(cachePath);
        if (!cached.isEmpty()) return cached;
      }
    }
  } catch {
    // regenerate below
  }

  const full = nativeImage.createFromPath(logoPath);
  if (full.isEmpty()) return logoPath;

  const small = full.resize({ width: size, height: size, quality: 'better' });
  try {
    fs.writeFileSync(cachePath, small.toPNG());
  } catch (err) {
    console.error('Failed to cache tray icon:', err);
  }
  return small;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 940,
    minWidth: 980,
    minHeight: 700,
    show: false,
    frame: false,
    title: 'Sortify',
    autoHideMenuBar: true,
    icon: getAppLogoPath(),
    webPreferences: {
      preload: path.join(__dirname_mapped, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);

  // Always load built UI from disk (no Vite server / no hot reload)
  mainWindow.loadFile(path.join(__dirname_mapped, '../dist/index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!shouldStartHidden()) {
      mainWindow?.show();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  tray = new Tray(getTrayIcon());
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      isQuitting = true;
      app.quit();
    }}
  ]);
  tray.setToolTip('Sortify');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow?.show();
  });
}

// IPC Handlers
ipcMain.handle('get-settings', () => {
  return currentSettings;
});

ipcMain.handle('save-settings', (event, newSettings: Partial<AppSettings>) => {
  const previousDirs = [...currentSettings.monitoredDirectories];
  // setCustomIcons is owned by set-custom-icons-enabled (applies/clears icons).
  const { setCustomIcons: _ignored, ...rest } = newSettings;
  currentSettings = {
    ...currentSettings,
    ...rest,
    setCustomIcons: currentSettings.setCustomIcons,
    categoryIcons: newSettings.categoryIcons ?? currentSettings.categoryIcons,
  };
  saveSettings();
  setupWatcher();

  // When monitored dirs change, apply any custom icons to existing category folders
  const dirsChanged =
    previousDirs.length !== currentSettings.monitoredDirectories.length ||
    previousDirs.some((d, i) => d !== currentSettings.monitoredDirectories[i]);

  if (dirsChanged && currentSettings.setCustomIcons) {
    for (const category of CATEGORIES) {
      const icoPath = currentSettings.categoryIcons[category];
      if (icoPath) {
        applyCategoryIconToMonitoredDirs(
          category,
          currentSettings.monitoredDirectories,
          icoPath
        );
      }
    }

    const defaultIco = getGenericDefaultIconPath();
    if (fs.existsSync(defaultIco)) {
      applyGenericDefaultIconToTopLevelFolders(
        currentSettings.monitoredDirectories,
        defaultIco
      );
    }
  }

  return true;
});

ipcMain.handle('set-custom-icons-enabled', async (_event, enabled: boolean) => {
  const next = Boolean(enabled);
  const iconsMissing =
    next &&
    currentSettings.setCustomIcons &&
    Object.keys(currentSettings.categoryIcons).length === 0;

  // Skip only when state already matches AND (if enabling) icons are actually present.
  // A failed prior enable can leave setCustomIcons=true with empty categoryIcons; that
  // must not early-return or bundled defaults never get applied again.
  if (next === currentSettings.setCustomIcons && !iconsMissing) {
    return { settings: currentSettings, previews: getCategoryIconPreviews() };
  }

  if (next) {
    try {
      // Wipe any leftover user uploads / stale caches before restoring bundled defaults.
      clearAllCategoryIcons(
        currentSettings.monitoredDirectories,
        currentSettings.categoryIcons
      );
      currentSettings.categoryIcons = {};

      const icons = await applyBundledDefaultCategoryIcons(
        currentSettings.monitoredDirectories
      );
      currentSettings.setCustomIcons = true;
      currentSettings.categoryIcons = icons;
      saveSettings();
      sendLog(
        'Custom icons enabled — applied category icons and DefaultIcon to existing top-level folders'
      );
    } catch (err) {
      // Roll back so UI/main stay in sync and a later toggle can retry.
      currentSettings.setCustomIcons = false;
      currentSettings.categoryIcons = {};
      try {
        clearAllCategoryIcons(currentSettings.monitoredDirectories, {});
      } catch {
        // ignore
      }
      saveSettings();
      throw err;
    }
  } else {
    clearAllCategoryIcons(
      currentSettings.monitoredDirectories,
      currentSettings.categoryIcons
    );
    currentSettings.setCustomIcons = false;
    currentSettings.categoryIcons = {};
    saveSettings();
    sendLog('Custom icons disabled — restored Windows default folder icons');
  }

  return { settings: currentSettings, previews: getCategoryIconPreviews() };
});

ipcMain.on('window-control', (event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
  if (action === 'close') mainWindow.close();
});

ipcMain.handle('select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('get-categories', () => CATEGORIES);

ipcMain.handle('select-image-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'] },
    ],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle(
  'set-category-icon',
  async (
    _event,
    payload: { category: string; sourceType: 'file' | 'url'; value: string }
  ) => {
    if (!currentSettings.setCustomIcons) {
      throw new Error('Enable Set Custom Icons first');
    }

    const { category, sourceType, value } = payload;
    if (!category || !value?.trim()) {
      throw new Error('Category and image source are required');
    }

    const icoPath = await convertSourceToCategoryIco(category, {
      type: sourceType,
      value: value.trim(),
    });

    currentSettings.categoryIcons = {
      ...currentSettings.categoryIcons,
      [category]: icoPath,
    };
    saveSettings();
    applyCategoryIconToMonitoredDirs(
      category,
      currentSettings.monitoredDirectories,
      icoPath
    );

    sendLog(`Custom icon set for ${category} folders`);
    return {
      category,
      iconPath: icoPath,
      previewDataUrl: iconFileToDataUrl(icoPath),
      settings: currentSettings,
    };
  }
);

ipcMain.handle('clear-category-icon', (_event, category: string) => {
  if (!currentSettings.setCustomIcons) {
    throw new Error('Enable Set Custom Icons first');
  }
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    throw new Error(`Unknown category: ${category}`);
  }

  const existing = currentSettings.categoryIcons[category];
  applyCategoryIconToMonitoredDirs(category, currentSettings.monitoredDirectories, null);

  if (existing && fs.existsSync(existing)) {
    try {
      fs.unlinkSync(existing);
    } catch {
      // ignore
    }
  }

  // Also remove canonical path if different
  const canonical = getCategoryIconPath(category);
  if (canonical !== existing && fs.existsSync(canonical)) {
    try {
      fs.unlinkSync(canonical);
    } catch {
      // ignore
    }
  }

  const { [category]: _removed, ...rest } = currentSettings.categoryIcons;
  currentSettings.categoryIcons = rest;
  saveSettings();
  sendLog(`Custom icon cleared for ${category} folders`);
  return { category, settings: currentSettings };
});

ipcMain.handle('get-category-icon-previews', () => getCategoryIconPreviews());

// App Lifecycle
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.name = 'Sortify';
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.gargantuavoided.sortify');
  }
  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    try {
      createTray();
    } catch (e) {
      console.error("Could not create tray, maybe missing icon?", e);
    }
    setupWatcher();

    // Defer Startup shortcut / registry work so first paint isn't blocked by PowerShell
    setImmediate(() => {
      try {
        applyAutostartSettings();
      } catch (e) {
        console.error('Deferred autostart failed:', e);
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
