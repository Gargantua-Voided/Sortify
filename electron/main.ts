import { app, BrowserWindow, ipcMain, dialog, Tray, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import AdmZip from 'adm-zip';

// CommonJS equivalent for __dirname since we might build to CJS or ESM,
// but since esbuild outputs CJS, we can just use __dirname.
// Wait, esbuild with format=cjs wraps it, but just in case:
const __dirname_mapped = __dirname;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let watcher: chokidar.FSWatcher | null = null;

// Settings structure
interface AppSettings {
  autoUnzip: boolean;
  autostart: boolean;
  monitoredDirectories: string[];
  scanInterval: number;
  ignoredFileTypes: string[];
}

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let currentSettings: AppSettings = {
  autoUnzip: false,
  autostart: false,
  monitoredDirectories: [],
  scanInterval: 5,
  ignoredFileTypes: ['.tmp', '.crdownload', '.part', '.ini'],
};

// Load settings
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      currentSettings = { ...currentSettings, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

// Save settings
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf-8');
    // Update autostart
    app.setLoginItemSettings({
      openAtLogin: currentSettings.autostart,
      path: process.execPath,
    });
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

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

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
    width: 900,
    height: 700,
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
    mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
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
      app.isQuiting = true;
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

ipcMain.handle('save-settings', (event, newSettings: AppSettings) => {
  currentSettings = newSettings;
  saveSettings();
  setupWatcher();
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

// App Lifecycle
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
