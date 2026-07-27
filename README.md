<div align="center">
  <img src="logo.png" alt="Sortify Logo" width="128" height="128" />
  
  # Sortify

  **A sleek, automated desktop application to organize your files seamlessly.**

<img width="900" height="600" alt="image" src="https://github.com/user-attachments/assets/4b54f144-b8db-4510-813c-7eb3ba9223f9" />


</div>

---

## 📌 Overview

**Sortify** is an elegant, offline-first Electron desktop application designed to automatically sort your files into categorized folders based on their file types. Running quietly in the system tray, it continuously monitors your chosen directories and organizes your clutter in real-time.

## ✨ Features

- **Automated Sorting:** Automatically categorizes files into specific folders (Images, Videos, Audio, Documents, Archives, Executables, etc.).
- **System Tray Integration:** Runs in the background with minimal footprint, accessible directly from the Windows system tray.
- **Auto Unzip:** Optionally extract `.zip` archives automatically when they drop into monitored folders.
- **Real-Time Logs:** Built-in activity log dashboard to track every file operation, move, and extraction in real-time.
- **Highly Customizable:** 
  - Manage multiple monitored directories.
  - Set custom scan intervals to balance responsiveness and performance.
  - Define ignored file extensions (e.g., `.tmp`, `.crdownload`, `.part`).
- **Autostart:** Configure the app to launch automatically when you boot up your computer.
- **Elegant UI:** A beautiful, dark-themed interface built with React and Tailwind CSS.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) installed on your machine.
- Windows OS (Tested & optimized for Windows 10/11).

### Installation

1. **Clone or Download** the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

To run the application in development mode with hot-reloading:

```bash
# Terminal 1: Start the Vite frontend dev server
npm run dev

# Terminal 2: Wait for Vite to start, then launch the Electron app
npm run electron:start
```

### Build & Release

To build an unpacked, runnable version of the application for Windows, run the provided PowerShell script:

```powershell
.\build-unpacked.ps1
```

This script will:
1. Install NPM dependencies.
2. Build the React frontend and Electron backend using Vite and esbuild.
3. Package the unpacked application using `electron-builder` into the `release/` directory.

Alternatively, you can manually trigger the build:
```bash
npm run build
npx electron-builder --win dir --x64
```

## 🛠️ Tech Stack

- **Framework:** [Electron](https://www.electronjs.org/) for the desktop environment.
- **Frontend:** [React](https://reactjs.org/) + [Vite](https://vitejs.dev/) for blazing fast UI development.
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) for the modern, elegant dark theme.
- **File System:** `chokidar` for efficient file watching, `adm-zip` for archive extraction.

## 📝 License

This project is open-source and available under the MIT License.
