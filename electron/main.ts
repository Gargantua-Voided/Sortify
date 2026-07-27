import { app, BrowserWindow, ipcMain, dialog, Tray, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import chokidar from 'chokidar';
import AdmZip from 'adm-zip';
import {
  CATEGORIES,
  applyCategoryIconToMonitoredDirs,
  convertSourceToCategoryIco,
  ensureCategoryFolderIcon,
  getCategoryIconPath,
  iconFileToDataUrl,
} from './categoryIcons';

// CommonJS equivalent for __dirname since we might build to CJS or ESM,
// but since esbuild outputs CJS, we can just use __dirname.
// Wait, esbuild with format=cjs wraps it, but just in case:
const __dirname_mapped = __dirname;

const AUTOSTART_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_VALUE_NAME = 'Sortify';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: chokidar.FSWatcher | null = null;
let isQuitting = false;

// Settings structure
interface AppSettings {
  autoUnzip: boolean;
  autostart: boolean;
  launchMinimized: boolean;
  monitoredDirectories: string[];
  scanInterval: number;
  ignoredFileTypes: string[];
  /** Absolute paths to per-category .ico files in userData */
  categoryIcons: Record<string, string>;
}

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let currentSettings: AppSettings = {
  autoUnzip: false,
  autostart: true,
  launchMinimized: false,
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

/**
 * Windows Run-key entries break when the exe path contains spaces unless the
 * entire command is quoted. Electron's setLoginItemSettings historically omits
 * those quotes, so we write the registry value ourselves for reliability.
 */
function applyAutostartSettings() {
  if (!app.isPackaged) return;

  const loginArgs = currentSettings.launchMinimized ? ['--hidden'] : [];

  try {
    app.setLoginItemSettings({
      openAtLogin: currentSettings.autostart,
      openAsHidden: currentSettings.launchMinimized,
      name: AUTOSTART_VALUE_NAME,
      path: process.execPath,
      args: loginArgs,
      enabled: currentSettings.autostart,
    });
  } catch (err) {
    console.error('setLoginItemSettings failed:', err);
  }

  if (process.platform !== 'win32') return;

  try {
    if (currentSettings.autostart) {
      const command = currentSettings.launchMinimized
        ? `"${process.execPath}" --hidden`
        : `"${process.execPath}"`;
      execFileSync(
        'reg',
        ['add', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'],
        { stdio: 'ignore', windowsHide: true }
      );
    } else {
      try {
        execFileSync(
          'reg',
          ['delete', AUTOSTART_REG_KEY, '/v', AUTOSTART_VALUE_NAME, '/f'],
          { stdio: 'ignore', windowsHide: true }
        );
      } catch {
        // Value may not exist yet — that's fine.
      }
    }
  } catch (err) {
    console.error('Failed to update Windows autostart registry entry:', err);
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
    }

    // Ensure autostart is correctly set in OS registry, especially if app was updated or moved
    applyAutostartSettings();
  } catch (err) {
    console.error('Error loading settings:', err);
  }
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
    ensureCategoryFolderIcon(targetDir, category, currentSettings.categoryIcons);

    const targetPath = path.join(targetDir, filename);
    
    // Avoid moving if it's already there
    if (filePath !== targetPath) {
      // simple rename (might fail across partitions, but okay for same dir)
      fs.renameSync(filePath, targetPath);
      sendLog(`Moved ${filename} to ${category} folder`);
    }

  } catch (error) {
    sendLog(`Error processing ${filePath}: ${String(error)}`);
  }
}

function setupWatcher() {
  if (watcher) {
    watcher.close();
  }
  
  if (currentSettings.monitoredDirectories.length === 0) return;

  watcher = chokidar.watch(currentSettings.monitoredDirectories, {
    ignored: (filePath: string) => {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    show: false,
    frame: false,
    title: 'Sortify',
    autoHideMenuBar: true,
    icon: path.join(__dirname_mapped, '../logo.png'),
    webPreferences: {
      preload: path.join(__dirname_mapped, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);

  // Depending on env, load Vite dev server or local file
  const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;
  if (isDev) {
    // Connect to the Vite dev server running on port 3000
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname_mapped, '../dist/index.html'));
  }

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
  // Use a generic icon if none provided. A robust app would include an icon file.
  // For demonstration, we'll try to find an icon or just fail gracefully.
  tray = new Tray(path.join(__dirname_mapped, '../logo.png')); // Using logo.png as icon
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
  currentSettings = {
    ...currentSettings,
    ...newSettings,
    categoryIcons: newSettings.categoryIcons ?? currentSettings.categoryIcons,
  };
  saveSettings();
  setupWatcher();

  // When monitored dirs change, apply any custom icons to existing category folders
  const dirsChanged =
    previousDirs.length !== currentSettings.monitoredDirectories.length ||
    previousDirs.some((d, i) => d !== currentSettings.monitoredDirectories[i]);

  if (dirsChanged) {
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
  }

  return true;
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

ipcMain.handle('get-category-icon-previews', () => {
  const previews: Record<string, string | null> = {};
  for (const category of CATEGORIES) {
    const icoPath = currentSettings.categoryIcons[category];
    previews[category] = icoPath ? iconFileToDataUrl(icoPath) : null;
  }
  return previews;
});

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
