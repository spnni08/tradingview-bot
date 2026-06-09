const { app, BrowserWindow, Menu, shell } = require('electron');

const APP_URL = 'https://tradingview-dashboard.pages.dev';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  // Open external links in default browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://tradingview-dashboard.pages.dev') &&
        !url.startsWith('https://tradingview-bot.spnn08.workers.dev')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  createWindow();
  setMenu();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function setMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `Über ${app.name}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `${app.name} beenden` },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload',          label: 'Neu laden' },
        { type: 'separator' },
        { role: 'resetZoom',       label: 'Originalgröße' },
        { role: 'zoomIn',          label: 'Vergrößern' },
        { role: 'zoomOut',         label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo',      label: 'Rückgängig' },
        { role: 'redo',      label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut',       label: 'Ausschneiden' },
        { role: 'copy',      label: 'Kopieren' },
        { role: 'paste',     label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
