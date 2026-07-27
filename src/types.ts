export interface AppSettings {
  autoUnzip: boolean;
  autostart: boolean;
  launchMinimized: boolean;
  monitoredDirectories: string[];
  scanInterval: number;
  ignoredFileTypes: string[];
}

export interface LogMessage {
  timestamp: string;
  message: string;
}

declare global {
  interface Window {
    electronAPI?: {
      getSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<boolean>;
      selectDirectory: () => Promise<string | null>;
      onLogMessage: (callback: (data: LogMessage) => void) => void;
      removeLogListener: () => void;
      windowControl?: (action: 'minimize' | 'maximize' | 'close') => void;
    };
  }
}
