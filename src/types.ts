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

export interface AppSettings {
  autoUnzip: boolean;
  autoRename: boolean;
  autostart: boolean;
  launchMinimized: boolean;
  monitoredDirectories: string[];
  scanInterval: number;
  ignoredFileTypes: string[];
  categoryIcons: Record<string, string>;
}

export interface LogMessage {
  timestamp: string;
  message: string;
}

export interface CategoryIconResult {
  category: string;
  iconPath?: string;
  previewDataUrl?: string | null;
  settings: AppSettings;
}

declare global {
  interface Window {
    electronAPI?: {
      getSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<boolean>;
      selectDirectory: () => Promise<string | null>;
      selectImageFile: () => Promise<string | null>;
      getCategories: () => Promise<string[]>;
      setCategoryIcon: (payload: {
        category: string;
        sourceType: 'file' | 'url';
        value: string;
      }) => Promise<CategoryIconResult>;
      clearCategoryIcon: (category: string) => Promise<CategoryIconResult>;
      getCategoryIconPreviews: () => Promise<Record<string, string | null>>;
      onLogMessage: (callback: (data: LogMessage) => void) => void;
      removeLogListener: () => void;
      windowControl?: (action: 'minimize' | 'maximize' | 'close') => void;
    };
  }
}
