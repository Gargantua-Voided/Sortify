import { app, nativeImage, net } from 'electron';
import path from 'path';
import fs from 'fs';
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

  return nativeImage.createFromBuffer(buffer);
}

export async function convertSourceToCategoryIco(
  category: string,
  source: { type: 'file' | 'url'; value: string }
): Promise<string> {
  if (!CATEGORIES.includes(category as CategoryName)) {
    throw new Error(`Unknown category: ${category}`);
  }

  let image: Electron.NativeImage;

  if (source.type === 'file') {
    if (!fs.existsSync(source.value)) {
      throw new Error('Image file not found');
    }
    const ext = path.extname(source.value).toLowerCase();
    const dest = getCategoryIconPath(category);

    // Already an ICO — copy as-is for best fidelity.
    if (ext === '.ico') {
      fs.copyFileSync(source.value, dest);
      return dest;
    }

    image = nativeImage.createFromPath(source.value);
  } else {
    image = await loadImageFromUrl(source.value);
  }

  const ico = imageToMultiSizeIco(image);
  const dest = getCategoryIconPath(category);
  fs.writeFileSync(dest, ico);
  return dest;
}

export function applyFolderIcon(folderPath: string, icoPath: string): void {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(folderPath) || !fs.existsSync(icoPath)) return;

  const desktopIniPath = path.join(folderPath, 'desktop.ini');
  // IconResource needs backslashes; quote-free absolute path.
  const iconResource = icoPath.replace(/\//g, '\\');

  const contents =
    `[.ShellClassInfo]\r\n` +
    `IconResource=${iconResource},0\r\n` +
    `IconFile=${iconResource}\r\n` +
    `IconIndex=0\r\n`;

  try {
    // Clear hidden/system so we can overwrite an existing desktop.ini
    try {
      execFileSync('attrib', ['-h', '-s', desktopIniPath], { stdio: 'ignore', windowsHide: true });
    } catch {
      // File may not exist yet.
    }

    fs.writeFileSync(desktopIniPath, contents, 'utf8');

    // Windows only reads desktop.ini for folders marked read-only.
    execFileSync('attrib', ['+r', folderPath], { stdio: 'ignore', windowsHide: true });
    execFileSync('attrib', ['+h', '+s', desktopIniPath], { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    console.error(`Failed to apply folder icon to ${folderPath}:`, err);
    throw err;
  }
}

export function clearFolderIcon(folderPath: string): void {
  if (process.platform !== 'win32') return;
  const desktopIniPath = path.join(folderPath, 'desktop.ini');
  if (!fs.existsSync(desktopIniPath)) return;

  try {
    try {
      execFileSync('attrib', ['-h', '-s', desktopIniPath], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
    fs.unlinkSync(desktopIniPath);
    try {
      execFileSync('attrib', ['-r', folderPath], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
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
    const image = nativeImage.createFromPath(icoPath);
    if (image.isEmpty()) {
      // Fallback: read raw bytes as base64 (works for preview of png copies too)
      const buf = fs.readFileSync(icoPath);
      return `data:image/x-icon;base64,${buf.toString('base64')}`;
    }
    const png = image.resize({ width: 48, height: 48, quality: 'best' }).toPNG();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}
