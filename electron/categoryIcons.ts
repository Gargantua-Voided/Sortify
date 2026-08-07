import { app, nativeImage, net } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';

export const CATEGORIES = [
  'Images',
  'Videos',
  'Audio',
  'Documents',
  'Archives',
  'Executables',
  'Others',
] as const;

export type CategoryName = (typeof CATEGORIES)[number];

/**
 * Legacy fixed name (pre cache-bust). Current writes use SortifyFolder-<hash>.ico
 * so Explorer does not keep serving a stale bitmap for the same IconResource path.
 */
export const FOLDER_ICON_FILENAME = 'SortifyFolder.ico';
const FOLDER_ICON_NAME_RE = /^sortifyfolder([-.a-z0-9]*)\.ico$/i;

const ICON_SIZES = [16, 32, 48, 256] as const;

export function getCategoryIconsDir(): string {
  const dir = path.join(app.getPath('userData'), 'category-icons');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getCategoryIconPath(category: string): string {
  return path.join(getCategoryIconsDir(), `${category}.ico`);
}

/** Bundled PNGs shipped with the app (see /default_icons). */
export const DEFAULT_CATEGORY_ICON_FILES: Record<CategoryName, string> = {
  Images: 'ImageIcon.png',
  Videos: 'MediaIcon.png',
  Audio: 'MusicIcon.png',
  Documents: 'DocumentIcon.png',
  Archives: 'ArchiveIcon.png',
  Executables: 'AppIcon.png',
  Others: 'OtherIcon.png',
};

/** Applied to existing top-level folders that are not Sortify category folders. */
export const DEFAULT_FOLDER_ICON_FILE = 'DefaultIcon.png';

export function getDefaultIconsDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'default_icons');
  }
  // Dev / unpackaged: project root (package.json directory)
  return path.join(app.getAppPath(), 'default_icons');
}

export function getGenericDefaultIconPath(): string {
  return path.join(getCategoryIconsDir(), 'Default.ico');
}

export function isCategoryDirectoryName(name: string): boolean {
  return (CATEGORIES as readonly string[]).includes(name);
}

/** Immediate child directories only — not recursive. */
export function listTopLevelDirectories(parentPath: string): string[] {
  if (!fs.existsSync(parentPath)) return [];
  try {
    return fs
      .readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentPath, entry.name));
  } catch {
    return [];
  }
}

export function isSortifyFolderMetaFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return name.toLowerCase() === 'desktop.ini' || FOLDER_ICON_NAME_RE.test(name);
}

function folderIconFileName(icoBytes: Buffer): string {
  const hash = crypto.createHash('sha1').update(icoBytes).digest('hex').slice(0, 10);
  // Per-apply nonce so OFF→ON with the same bundled bytes still gets a new IconResource
  // path — Explorer caches by path and will keep the first bitmap otherwise.
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `SortifyFolder-${hash}-${nonce}.ico`;
}

function listLocalFolderIconFiles(folderPath: string): string[] {
  try {
    return fs
      .readdirSync(folderPath)
      .filter((name) => FOLDER_ICON_NAME_RE.test(name))
      .map((name) => path.join(folderPath, name));
  } catch {
    return [];
  }
}

function removeLocalFolderIconFiles(folderPath: string, keepName?: string): void {
  for (const filePath of listLocalFolderIconFiles(folderPath)) {
    if (keepName && path.basename(filePath).toLowerCase() === keepName.toLowerCase()) {
      continue;
    }
    clearFileAttribs(filePath);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore locked/in-use leftovers
    }
  }
}

/** Build a multi-size ICO file from PNG buffers (PNG-compressed ICO, Vista+). */
export function pngBuffersToIco(pngBuffers: Buffer[]): Buffer {
  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;
  const dataOffset = headerSize + entrySize * count;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const entries: Buffer[] = [];
  let offset = dataOffset;

  for (const png of pngBuffers) {
    const entry = Buffer.alloc(entrySize);
    // Infer dimensions from IHDR when possible; fall back to 0 (256).
    let width = 0;
    let height = 0;
    if (png.length >= 24 && png.toString('ascii', 1, 4) === 'PNG') {
      width = png.readUInt32BE(16);
      height = png.readUInt32BE(20);
    }
    entry.writeUInt8(width >= 256 ? 0 : width, 0);
    entry.writeUInt8(height >= 256 ? 0 : height, 1);
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers]);
}

function imageToMultiSizeIco(image: Electron.NativeImage): Buffer {
  if (image.isEmpty()) {
    throw new Error('Could not decode image');
  }

  const pngBuffers = ICON_SIZES.map((size) => {
    const resized = image.resize({
      width: size,
      height: size,
      quality: 'best',
    });
    return resized.toPNG();
  });

  return pngBuffersToIco(pngBuffers);
}

/**
 * Read image bytes via fs first. nativeImage.createFromPath() can fail for files
 * inside folders that already have a custom desktop.ini icon (Windows shell).
 */
function loadImageFromFile(filePath: string): Electron.NativeImage {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) {
    throw new Error('Image file is empty');
  }
  if (buffer.length > 15 * 1024 * 1024) {
    throw new Error('Image is too large (max 15MB)');
  }

  let image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(filePath);
  }
  if (image.isEmpty()) {
    throw new Error('Could not decode image');
  }
  return image;
}

/**
 * Copy a source file out of managed category folders before conversion/application.
 * Selecting an icon from e.g. Images/Flower.png while we also write desktop.ini into
 * Images/ races with Explorer's file dialog lock on that folder.
 */
function stageSourceToTemp(filePath: string): string {
  const ext = path.extname(filePath) || '.img';
  const tempPath = path.join(
    os.tmpdir(),
    `sortify-icon-src-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  );
  fs.writeFileSync(tempPath, fs.readFileSync(filePath));
  return tempPath;
}

async function loadImageFromUrl(url: string): Promise<Electron.NativeImage> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) image URLs are supported');
  }

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const request = net.request(url);
    const chunks: Buffer[] = [];

    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        reject(new Error(`Failed to download image (HTTP ${status})`));
        return;
      }

      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.on('error', reject);
    request.end();
  });

  if (buffer.length > 15 * 1024 * 1024) {
    throw new Error('Image is too large (max 15MB)');
  }

  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new Error('Could not decode image from URL');
  }
  return image;
}

export async function convertSourceToCategoryIco(
  category: string,
  source: { type: 'file' | 'url'; value: string }
): Promise<string> {
  if (!CATEGORIES.includes(category as CategoryName)) {
    throw new Error(`Unknown category: ${category}`);
  }
  return writeSourceToIcoFile(getCategoryIconPath(category), source);
}

async function writeSourceToIcoFile(
  dest: string,
  source: { type: 'file' | 'url'; value: string }
): Promise<string> {
  let stagedTemp: string | null = null;

  try {
    if (source.type === 'file') {
      if (!fs.existsSync(source.value)) {
        throw new Error('Image file not found');
      }

      // Always stage out of potentially managed/locked category folders first.
      stagedTemp = stageSourceToTemp(source.value);
      const ext = path.extname(stagedTemp).toLowerCase();

      // Already an ICO — copy staged bytes as-is for best fidelity.
      if (ext === '.ico') {
        fs.writeFileSync(dest, fs.readFileSync(stagedTemp));
        return dest;
      }

      const image = loadImageFromFile(stagedTemp);
      fs.writeFileSync(dest, imageToMultiSizeIco(image));
      return dest;
    }

    const image = await loadImageFromUrl(source.value);
    fs.writeFileSync(dest, imageToMultiSizeIco(image));
    return dest;
  } finally {
    if (stagedTemp) {
      try {
        fs.unlinkSync(stagedTemp);
      } catch {
        // ignore temp cleanup failures
      }
    }
  }
}

/** Convert bundled DefaultIcon.png into userData/Default.ico. */
export async function ensureBundledGenericDefaultIco(): Promise<string | null> {
  const sourcePath = path.join(getDefaultIconsDir(), DEFAULT_FOLDER_ICON_FILE);
  if (!fs.existsSync(sourcePath)) {
    console.warn(`Missing bundled default folder icon: ${sourcePath}`);
    return null;
  }
  return writeSourceToIcoFile(getGenericDefaultIconPath(), {
    type: 'file',
    value: sourcePath,
  });
}

function clearFileAttribs(filePath: string): void {
  try {
    execFileSync('attrib', ['-h', '-s', '-r', filePath], { stdio: 'ignore', windowsHide: true });
  } catch {
    // File may not exist yet.
  }
}

function notifyShellFolderUpdate(folderPath: string, icoFileName?: string): void {
  try {
    const escapedFolder = folderPath.replace(/'/g, "''");
    const parentPath = path.dirname(folderPath);
    const escapedParent = parentPath.replace(/'/g, "''");
    const localIco = icoFileName ? path.join(folderPath, icoFileName).replace(/'/g, "''") : '';

    // Explorer caches folder icons by IconResource path. Busting the filename is the
    // main fix; these notifies help the parent view (where the category folder appears)
    // pick up the new association without a full Explorer restart.
    // Use -MemberDefinition string (not a here-string) so a one-line -Command stays valid.
    const ps = [
      "Add-Type -Namespace Sortify -Name Shell32 -MemberDefinition '[DllImport(\"shell32.dll\", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, string dwItem2); [DllImport(\"shell32.dll\", CharSet=CharSet.Unicode)] public static extern void SHUpdateImageW(string pszHashItem, int iIndex, uint uFlags, int iImageIndex);';",
      // SHCNF_PATHW | SHCNF_FLUSHNOWAIT = 0x2005
      `[Sortify.Shell32]::SHChangeNotify(0x2000, 0x2005, '${escapedFolder}', $null);`, // SHCNE_UPDATEITEM
      `[Sortify.Shell32]::SHChangeNotify(0x1000, 0x2005, '${escapedFolder}', $null);`, // SHCNE_UPDATEDIR
      `[Sortify.Shell32]::SHChangeNotify(0x1000, 0x2005, '${escapedParent}', $null);`, // parent view
      `[Sortify.Shell32]::SHChangeNotify(0x2000, 0x2005, '${escapedParent}', $null);`,
      icoFileName
        ? `[Sortify.Shell32]::SHUpdateImageW('${localIco}', 0, 0, 0); [Sortify.Shell32]::SHChangeNotify(0x8000, 0x2005, '${localIco}', $null);` // SHCNE_UPDATEIMAGE
        : '',
      '[Sortify.Shell32]::SHChangeNotify(0x08000000, 0x0000, $null, $null);', // SHCNE_ASSOCCHANGED
    ].join(' ');

    // Fire-and-forget — never block the file watcher / sort loop on Explorer.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { stdio: 'ignore', windowsHide: true, detached: true }
    );
    child.unref();
  } catch {
    // Non-fatal: icon still applies, Explorer may need a refresh.
  }
}

/**
 * Delete Windows Explorer icon/thumb cache DBs and restart Explorer so folder icons reload.
 * Runs a real .ps1 (not a broken one-liner) and waits for completion so the UI
 * reports success only when Explorer was actually restarted.
 * Desktop/taskbar may flicker briefly — that's expected.
 */
export function clearExplorerIconCache(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      ok: false,
      message: 'Explorer icon cache clearing is only available on Windows',
    });
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const explorerCacheDir = path.join(localAppData, 'Microsoft', 'Windows', 'Explorer');
  const legacyIconCache = path.join(localAppData, 'IconCache.db');
  const scriptPath = path.join(
    os.tmpdir(),
    `sortify-clear-icon-cache-${process.pid}-${Date.now()}.ps1`
  );

  // Paths embedded via JSON.stringify so spaces/quotes are safe for PowerShell.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$legacy = ${JSON.stringify(legacyIconCache)}
$explorerDir = ${JSON.stringify(explorerCacheDir)}

function Stop-ExplorerShell {
  Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force
}

function Remove-CacheTarget([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  for ($i = 0; $i -lt 5; $i++) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    Stop-ExplorerShell
    Start-Sleep -Milliseconds 300
  }
  return $false
}

Stop-ExplorerShell
Start-Sleep -Milliseconds 500

$removed = 0
$failed = 0
$targets = @()

if (Test-Path -LiteralPath $legacy) {
  $targets += Get-Item -LiteralPath $legacy -Force
}
if (Test-Path -LiteralPath $explorerDir) {
  $targets += @(
    Get-ChildItem -LiteralPath $explorerDir -Force |
      Where-Object { $_.Name -like 'iconcache*' -or $_.Name -like 'thumbcache*' }
  )
}

foreach ($t in $targets) {
  if (Remove-CacheTarget $t.FullName) { $removed++ } else { $failed++ }
}

Start-Process -FilePath "$env:SystemRoot\\explorer.exe"
Start-Sleep -Milliseconds 1200

try {
  Add-Type -Namespace Sortify -Name ShellNotify -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);'
  [Sortify.ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {}

$ie4 = Join-Path $env:SystemRoot 'System32\\ie4uinit.exe'
if (Test-Path -LiteralPath $ie4) {
  & $ie4 -show 2>$null
}

Write-Output ("removed=" + $removed + ";failed=" + $failed + ";targets=" + $targets.Count)
if ($failed -gt 0 -and $removed -eq 0 -and $targets.Count -gt 0) {
  exit 1
}
exit 0
`.trim();

  return new Promise((resolve) => {
    try {
      fs.writeFileSync(scriptPath, script, 'utf8');
    } catch (err) {
      resolve({
        ok: false,
        message: `Failed to write cache-clear script: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const finish = (result: { ok: boolean; message: string }) => {
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        // temp cleanup is best-effort
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({
        ok: false,
        message: 'Timed out clearing Explorer icon cache (Explorer may still be restarting)',
      });
    }, 20000);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        message: `Failed to start cache clear: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const removedMatch = stdout.match(/removed=(\d+)/);
      const failedMatch = stdout.match(/failed=(\d+)/);
      const targetsMatch = stdout.match(/targets=(\d+)/);
      const removed = removedMatch ? Number(removedMatch[1]) : 0;
      const failed = failedMatch ? Number(failedMatch[1]) : 0;
      const targets = targetsMatch ? Number(targetsMatch[1]) : 0;

      if (code === 0) {
        if (removed > 0) {
          finish({
            ok: true,
            message: `Explorer icon cache cleared (${removed} file${removed === 1 ? '' : 's'} removed${
              failed > 0 ? `, ${failed} locked` : ''
            }) — Explorer restarted`,
          });
        } else {
          finish({
            ok: true,
            message:
              'Explorer restarted and icon cache refresh requested (no cache files were present to delete)',
          });
        }
        return;
      }

      finish({
        ok: false,
        message:
          targets > 0 && failed > 0
            ? `Could not delete icon cache (${failed} of ${targets} files locked). Try again, or reboot once.`
            : `Failed to clear icon cache (exit ${code ?? 'unknown'})${
                stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''
              }`,
      });
    });
  });
}

export function applyFolderIcon(
  folderPath: string,
  icoPath: string,
  options?: { notify?: boolean }
): void {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(folderPath) || !fs.existsSync(icoPath)) return;

  const notify = options?.notify !== false;
  const desktopIniPath = path.join(folderPath, 'desktop.ini');
  const icoBytes = fs.readFileSync(icoPath);
  const localIcoName = folderIconFileName(icoBytes);
  const localIcoPath = path.join(folderPath, localIcoName);

  // Relative icon path is more reliable than absolute AppData paths. A content hash
  // in the filename forces Explorer to treat updates as a new IconResource.
  const contents =
    `[.ShellClassInfo]\r\n` +
    `IconResource=${localIcoName},0\r\n` +
    `IconFile=${localIcoName}\r\n` +
    `IconIndex=0\r\n`;

  try {
    clearFileAttribs(desktopIniPath);
    clearFileAttribs(localIcoPath);
    removeLocalFolderIconFiles(folderPath, localIcoName);

    fs.writeFileSync(localIcoPath, icoBytes);
    fs.writeFileSync(desktopIniPath, contents, 'utf8');

    // Windows only reads desktop.ini for folders marked read-only.
    execFileSync('attrib', ['+r', folderPath], { stdio: 'ignore', windowsHide: true });
    execFileSync('attrib', ['+h', '+s', localIcoPath], { stdio: 'ignore', windowsHide: true });
    execFileSync('attrib', ['+h', '+s', desktopIniPath], { stdio: 'ignore', windowsHide: true });

    if (notify) {
      notifyShellFolderUpdate(folderPath, localIcoName);
    }
  } catch (err) {
    console.error(`Failed to apply folder icon to ${folderPath}:`, err);
    throw err;
  }
}

export function clearFolderIcon(folderPath: string): void {
  if (process.platform !== 'win32') return;

  const desktopIniPath = path.join(folderPath, 'desktop.ini');

  try {
    if (fs.existsSync(desktopIniPath)) {
      clearFileAttribs(desktopIniPath);
      try {
        fs.unlinkSync(desktopIniPath);
      } catch {
        // ignore
      }
    }
    removeLocalFolderIconFiles(folderPath);
    try {
      execFileSync('attrib', ['-r', folderPath], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
    notifyShellFolderUpdate(folderPath);
  } catch (err) {
    console.error(`Failed to clear folder icon on ${folderPath}:`, err);
  }
}

export function applyCategoryIconToMonitoredDirs(
  category: string,
  monitoredDirectories: string[],
  icoPath: string | null
): void {
  for (const monitored of monitoredDirectories) {
    const folderPath = path.join(monitored, category);
    if (!fs.existsSync(folderPath)) continue;

    if (icoPath && fs.existsSync(icoPath)) {
      applyFolderIcon(folderPath, icoPath);
    } else {
      clearFolderIcon(folderPath);
    }
  }
}

/** True when desktop.ini already points at an existing SortifyFolder*.ico. */
function folderHasValidSortifyIcon(folderPath: string): boolean {
  const desktopIniPath = path.join(folderPath, 'desktop.ini');
  if (!fs.existsSync(desktopIniPath)) return false;

  try {
    const contents = fs.readFileSync(desktopIniPath, 'utf8');
    const match = contents.match(/IconResource\s*=\s*([^,\r\n]+)/i);
    if (!match) return false;

    const icoName = path.basename(match[1].trim());
    if (!FOLDER_ICON_NAME_RE.test(icoName)) return false;

    return fs.existsSync(path.join(folderPath, icoName));
  } catch {
    return false;
  }
}

export function ensureCategoryFolderIcon(
  folderPath: string,
  category: string,
  categoryIcons: Record<string, string>,
  options?: { notify?: boolean }
): void {
  const icoPath = categoryIcons[category];
  if (!icoPath || !fs.existsSync(icoPath)) return;

  // Skip full rewrite when icon is already in place — re-applying on every file move
  // deletes the old .ico, rewrites desktop.ini with a new nonce, and makes Explorer
  // briefly (or longer) show the default folder icon.
  if (folderHasValidSortifyIcon(folderPath)) {
    try {
      // Soft re-assert read-only so Windows keeps honoring desktop.ini.
      execFileSync('attrib', ['+r', folderPath], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
    return;
  }

  try {
    applyFolderIcon(folderPath, icoPath, options);
  } catch {
    // Non-fatal during file sorting.
  }
}

/**
 * Apply the right Sortify icon to a top-level folder under a monitored directory:
 * category folders get their category icon; everything else gets DefaultIcon.
 * No-ops when the icon is already valid.
 */
export function ensureTopLevelFolderIcon(
  folderPath: string,
  categoryIcons: Record<string, string>,
  options?: { notify?: boolean }
): void {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(folderPath)) return;

  try {
    if (!fs.statSync(folderPath).isDirectory()) return;
  } catch {
    return;
  }

  const name = path.basename(folderPath);
  if (isCategoryDirectoryName(name)) {
    ensureCategoryFolderIcon(folderPath, name, categoryIcons, options);
    return;
  }

  if (folderHasValidSortifyIcon(folderPath)) {
    try {
      execFileSync('attrib', ['+r', folderPath], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
    return;
  }

  const defaultIco = getGenericDefaultIconPath();
  if (!defaultIco || !fs.existsSync(defaultIco)) return;

  try {
    applyFolderIcon(folderPath, defaultIco, options);
  } catch {
    // Non-fatal
  }
}

/** Apply already-prepared category/.default icons onto the given monitored dirs. */
export function applyStoredCategoryIconsToDirectories(
  monitoredDirectories: string[],
  categoryIcons: Record<string, string>
): void {
  if (monitoredDirectories.length === 0) return;

  for (const category of CATEGORIES) {
    const icoPath = categoryIcons[category];
    if (!icoPath || !fs.existsSync(icoPath)) continue;
    applyCategoryIconToMonitoredDirs(category, monitoredDirectories, icoPath);
  }

  const defaultIco = getGenericDefaultIconPath();
  if (fs.existsSync(defaultIco)) {
    applyGenericDefaultIconToTopLevelFolders(monitoredDirectories, defaultIco);
  }
}

/**
 * Apply already-prepared category / Default icons onto the given monitored directories.
 * Safe with an empty list (no-op).
 */
export function applyStoredCustomIconsToDirectories(
  monitoredDirectories: string[],
  categoryIcons: Record<string, string>
): void {
  if (monitoredDirectories.length === 0) return;

  for (const category of CATEGORIES) {
    const icoPath = categoryIcons[category];
    if (icoPath && fs.existsSync(icoPath)) {
      applyCategoryIconToMonitoredDirs(category, monitoredDirectories, icoPath);
    }
  }

  const defaultIco = getGenericDefaultIconPath();
  if (fs.existsSync(defaultIco)) {
    applyGenericDefaultIconToTopLevelFolders(monitoredDirectories, defaultIco);
  }
}

/** Convert bundled default PNGs to userData .ico files and apply to monitored dirs. */
export async function applyBundledDefaultCategoryIcons(
  monitoredDirectories: string[]
): Promise<Record<string, string>> {
  // Always start clean so OFF→ON (and custom→bundled fallback) is not blocked by
  // leftover desktop.ini / same IconResource paths from the previous cycle.
  // With no monitored dirs this is a no-op — icons are still prepared in userData.
  clearTopLevelFolderIcons(monitoredDirectories);

  const iconsDir = getDefaultIconsDir();
  const result: Record<string, string> = {};

  for (const category of CATEGORIES) {
    const fileName = DEFAULT_CATEGORY_ICON_FILES[category];
    const sourcePath = path.join(iconsDir, fileName);
    if (!fs.existsSync(sourcePath)) {
      console.warn(`Missing bundled default icon: ${sourcePath}`);
      continue;
    }

    // Always rebuild from bundled assets (never reuse a prior user upload left in userData).
    const icoPath = await convertSourceToCategoryIco(category, {
      type: 'file',
      value: sourcePath,
    });
    applyCategoryIconToMonitoredDirs(category, monitoredDirectories, icoPath);
    result[category] = icoPath;
  }

  // Existing top-level folders (not category dirs, not nested) get DefaultIcon.png
  const defaultIco = await ensureBundledGenericDefaultIco();
  if (defaultIco) {
    applyGenericDefaultIconToTopLevelFolders(monitoredDirectories, defaultIco);
  }

  return result;
}

/**
 * Apply Default.ico to immediate child folders of each monitored directory,
 * skipping Sortify category folders (those use their own icons).
 */
export function applyGenericDefaultIconToTopLevelFolders(
  monitoredDirectories: string[],
  icoPath: string
): void {
  if (!icoPath || !fs.existsSync(icoPath)) return;

  for (const monitored of monitoredDirectories) {
    for (const folderPath of listTopLevelDirectories(monitored)) {
      if (isCategoryDirectoryName(path.basename(folderPath))) continue;
      try {
        applyFolderIcon(folderPath, icoPath);
      } catch (err) {
        console.error(`Failed to apply default icon to ${folderPath}:`, err);
      }
    }
  }
}

/** Clear Sortify icons from every top-level folder under monitored dirs (non-recursive). */
export function clearTopLevelFolderIcons(monitoredDirectories: string[]): void {
  for (const monitored of monitoredDirectories) {
    for (const folderPath of listTopLevelDirectories(monitored)) {
      clearFolderIcon(folderPath);
    }
  }
}

/** Remove custom icons from all top-level folders and delete cached .ico files. */
export function clearAllCategoryIcons(
  monitoredDirectories: string[],
  categoryIcons: Record<string, string>
): void {
  clearTopLevelFolderIcons(monitoredDirectories);

  for (const category of CATEGORIES) {
    const existing = categoryIcons[category];
    if (existing && fs.existsSync(existing)) {
      try {
        fs.unlinkSync(existing);
      } catch {
        // ignore
      }
    }

    const canonical = getCategoryIconPath(category);
    if (canonical !== existing && fs.existsSync(canonical)) {
      try {
        fs.unlinkSync(canonical);
      } catch {
        // ignore
      }
    }
  }

  const genericDefault = getGenericDefaultIconPath();
  if (fs.existsSync(genericDefault)) {
    try {
      fs.unlinkSync(genericDefault);
    } catch {
      // ignore
    }
  }
}

export function iconFileToDataUrl(icoPath: string): string | null {
  if (!icoPath || !fs.existsSync(icoPath)) return null;
  try {
    const buffer = fs.readFileSync(icoPath);
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      image = nativeImage.createFromPath(icoPath);
    }
    if (image.isEmpty()) {
      return `data:image/x-icon;base64,${buffer.toString('base64')}`;
    }
    const png = image.resize({ width: 48, height: 48, quality: 'best' }).toPNG();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}
