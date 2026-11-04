'use strict';
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu, shell, screen } = require('electron');
const path = require('path');
const { Cluster } = require('./orchestrator');
const { Demo } = require('./demo');

let win, cluster, demo;
let demoOn = false;
const MAC = process.platform === 'darwin';

// One window only: opening the app again brings the running one forward.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// Settings and saved sessions live in the user's app-data folder (CT_DATA or CT_RUNTIME overrides, for testing).
const dataDir = process.env.CT_DATA || process.env.CT_RUNTIME || app.getPath('userData');

const EVENTS = ['agent', 'chat', 'feed', 'link', 'turn', 'reset'];
const toScreen = (type, data) => { if (win && !win.isDestroyed()) win.webContents.send('ct', { type, data }); };

function current() { return demoOn ? demo : cluster; }

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  try {
    cluster = new Cluster(__dirname, dataDir);
  } catch (e) {
    // Without this the app would sit in the background with no window.
    dialog.showErrorBox('Cluster Terminal could not start', `${e.message}

Settings folder: ${dataDir}`);
    return app.quit();
  }
  await cluster.start();
  demo = new Demo();
  demo.workspace = cluster.workspace;
  for (const ev of EVENTS) {
    cluster.on(ev, d => { if (!demoOn) toScreen(ev, d); });
    demo.on(ev, d => { if (demoOn) toScreen(ev, d); });
  }

  // Windowed size fits the screen it opens on (centered), and the minimum is small enough
  // that Windows snapping (Win+Arrow, drag to an edge, Snap Layouts) can give it half or a quarter of the screen.
  const work = screen.getPrimaryDisplay().workArea;
  let w = Math.min(1680, Math.round(work.width * 0.9)), h = Math.min(980, Math.round(work.height * 0.9));
  // CT_SNAP_SIZE=WxH: test the layout at a given window size (e.g. 768x900 for half a screen).
  const size = (process.env.CT_SNAP_SIZE || '').match(/^(\d+)x(\d+)$/);
  if (size) [w, h] = [+size[1], +size[2]];
  win = new BrowserWindow({
    width: w, height: h, x: work.x + Math.round((work.width - w) / 2), y: work.y + Math.round((work.height - h) / 2),
    minWidth: 480, minHeight: 360, resizable: true, movable: true, maximizable: true,
    backgroundColor: '#0a0c0b', title: 'Cluster Terminal', autoHideMenuBar: true,
    // Replace the system title bar with a black strip; keep the window buttons.
    titleBarStyle: 'hidden',
    ...(MAC ? { trafficLightPosition: { x: 12, y: 9 } } : { titleBarOverlay: { color: '#0a0c0b', symbolColor: '#7b8980', height: 30 } }),
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Macs need a menu for copy / paste / quit shortcuts; elsewhere there is none.
  if (MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  else win.setMenu(null);
  // Links in the chat open in the normal browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  // Full screen has no title bar, so the screen drops its drag strip.
  const markFull = () => win.webContents.executeJavaScript(`document.body.classList.toggle('full', ${win.isFullScreen()})`).catch(() => {});
  win.on('enter-full-screen', markFull);
  win.on('leave-full-screen', markFull);
  win.webContents.on('did-finish-load', markFull);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { theme: process.env.CT_THEME || cluster.cfg.theme || 'cluster' } });

  // For testing: CT_SNAP=<file.png> starts in demo mode, saves a screenshot, and quits.
  if (process.env.CT_SNAP) {
    win.webContents.once('did-finish-load', () => {
      demoOn = true;
      demo.start();
      if (process.env.CT_SNAP_FOCUS || process.env.CT_SNAP_ORCH) demo.setMode('orch');
      // CT_SNAP_JS: script to run in the page before the screenshot (for testing keys and commands).
      if (process.env.CT_SNAP_JS) setTimeout(() => win.webContents.executeJavaScript(process.env.CT_SNAP_JS), 3000);
      setTimeout(async () => {
        require('fs').writeFileSync(process.env.CT_SNAP, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, +(process.env.CT_SNAP_WAIT || 14000));
    });
  }
});

ipcMain.handle('ct:state', () => ({ ...current().state(), demo: demoOn }));
ipcMain.handle('ct:send', (e, { id, text }) => { if (!demoOn) cluster.userSend(id, text); });
ipcMain.handle('ct:stop', (e, { id }) => { if (!demoOn) cluster.stop(id); });
ipcMain.handle('ct:mode', (e, { mode }) => {
  if (demoOn) demo.setMode(mode); else cluster.setMode(mode);
  return { ...current().state(), demo: demoOn };
});
ipcMain.handle('ct:clearall', () => {
  if (demoOn) demo.setMode(demo.mode);
  else { cluster.clearAll(); for (const a of Object.values(cluster.agents)) cluster.sys(a.id, 'All sessions cleared. Next message starts fresh.'); }
  return { ...current().state(), demo: demoOn };
});
ipcMain.handle('ct:demo', (e, { on }) => {
  demoOn = !!on;
  if (demoOn) { demo.mode = cluster.mode; demo.start(); }
  else demo.stop();
  return { ...current().state(), demo: demoOn };
});
ipcMain.handle('ct:settings', () => shell.openPath(cluster.cfgPath));
ipcMain.handle('ct:info', () => ({ version: app.getVersion(), config: cluster.cfgPath, problems: cluster.setupProblems() }));
ipcMain.handle('ct:workspace', async () => {
  if (demoOn) return null;
  const r = await dialog.showOpenDialog(win, { title: 'Choose the project folder the agents work in', properties: ['openDirectory', 'createDirectory'], defaultPath: cluster.workspace });
  if (r.canceled || !r.filePaths[0]) return null;
  cluster.setWorkspace(r.filePaths[0]);
  demo.workspace = cluster.workspace;
  return { ...cluster.state(), demo: false };
});

app.on('window-all-closed', () => { cluster?.shutdown(); demo?.stop(); app.quit(); });
