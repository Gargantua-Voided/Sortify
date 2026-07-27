import { app, nativeImage, net } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';

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

/** Hidden icon filename written inside each category folder (relative desktop.ini). */
export const FOLDER_ICON_FILENAME = 'SortifyFolder.ico';

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

export function isSortifyFolderMetaFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name === 'desktop.ini' || name === FOLDER_ICON_FILENAME.toLowerCase();
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

  const dest = getCategoryIconPath(category);
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

function clearFileAttribs(filePath: string): void {
  try {
    execFileSync('attrib', ['-h', '-s', '-r', filePath], { stdio: 'ignore', windowsHide: true });
  } catch {
    // File may not exist yet.
  }
}

function notifyShellFolderUpdate(folderPath: string): void {
  try {
    // SHCNE_UPDATEDIR (0x00001000) + SHCNF_PATHW (0x0005) refreshes this folder in Explorer.
    const ps = [
      'Add-Type -Namespace Sortify -Name Shell32 -MemberDefinition @"',
      '[DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, string dwItem2);',
      '"@;',
      `[Sortify.Shell32]::SHChangeNotify(0x1000, 0x0005, '${folderPath.replace(/'/g, "''")}', $null);`,
      '[Sortify.Shell32]::SHChangeNotify(0x08000000, 0x0000, $null, $null);',
    ].join(' ');

    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
    });
  } catch {
    // Non-fatal: icon still applies, Explorer may need a refresh.
  }
}

export function applyFolderIcon(folderPath: string, icoPath: string): void {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(folderPath) || !fs.existsSync(icoPath)) return;

  const desktopIniPath = path.join(folderPath, 'desktop.ini');
  const localIcoPath = path.join(folderPath, FOLDER_ICON_FILENAME);

  // Relative icon path is more reliable than absolute AppData paths, and avoids
  // stale shell state when the source image lived inside this same folder.
  const contents =
    `[.ShellClassInfo]\r\n` +
    `IconResource=${FOLDER_ICON_FILENAME},0\r\n` +
    `IconFile=${FOLDER_ICON_FILENAME}\r\n` +
    `IconIndex=0\r\n`;

  try {
    clearFileAttribs(desktopIniPath);
    clearFileAttribs(localIcoPath);

    // Copy icon bytes into the folder first (from userData cache, not the source image).
    fs.writeFileSync(localIcoPath, fs.readFileSync(icoPath));
    fs.writeFileSync(desktopIniPath, contents, 'utf8');

    // Windows only reads desktop.ini for folders marked read-only.
    execFileSync('attrib', ['+r', folderPath], { stdio: 'ignore', windowsHide: true });
    execFileSync('attrib', ['+h', '+s', localIcoPath], { stdio: 'ignore', windowsHide: true });
    execFileSync('attrib', ['+h', '+s', desktopIniPath], { stdio: 'ignore', windowsHide: true });

    notifyShellFolderUpdate(folderPath);
  } catch (err) {
    console.error(`Failed to apply folder icon to ${folderPath}:`, err);
    throw err;
  }
}

export function clearFolderIcon(folderPath: string): void {
  if (process.platform !== 'win32') return;

  const desktopIniPath = path.join(folderPath, 'desktop.ini');
  const localIcoPath = path.join(folderPath, FOLDER_ICON_FILENAME);

  try {
    for (const filePath of [desktopIniPath, localIcoPath]) {
      if (!fs.existsSync(filePath)) continue;
      clearFileAttribs(filePath);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
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

export function ensureCategoryFolderIcon(
  folderPath: string,
  category: string,
  categoryIcons: Record<string, string>
): void {
  const icoPath = categoryIcons[category];
  if (!icoPath || !fs.existsSync(icoPath)) return;

  // Always (re)apply so newly created folders get the custom icon.
  try {
    applyFolderIcon(folderPath, icoPath);
  } catch {
    // Non-fatal during file sorting.
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
