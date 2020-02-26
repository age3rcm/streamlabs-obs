'use strict';

////////////////////////////////////////////////////////////////////////////////
// Set Up Environment Variables
////////////////////////////////////////////////////////////////////////////////
const pjson = require('./package.json');
if (pjson.env === 'production') {
  process.env.NODE_ENV = 'production';
}
if (pjson.name === 'slobs-client-preview') {
  process.env.SLOBS_PREVIEW = true;
}
if (pjson.name === 'slobs-client-ipc') {
  process.env.SLOBS_IPC = true;
}
process.env.SLOBS_VERSION = pjson.version;

////////////////////////////////////////////////////////////////////////////////
// Modules and other Requires
////////////////////////////////////////////////////////////////////////////////
const { app, BrowserWindow, ipcMain, session, crashReporter, dialog, webContents } = require('electron');
const path = require('path');
const rimraf = require('rimraf');
const electronLog = require('electron-log');

const overlay = require('@streamlabs/game-overlay');

// We use a special cache directory for running tests
if (process.env.SLOBS_CACHE_DIR) {
  app.setPath('appData', process.env.SLOBS_CACHE_DIR);
  electronLog.transports.file.file = path.join(
    process.env.SLOBS_CACHE_DIR,
    'slobs-client',
    'log.log'
  );
}

app.setPath('userData', path.join(app.getPath('appData'), 'slobs-client'));

if (process.argv.includes('--clearCacheDir')) {
  rimraf.sync(app.getPath('userData'));
}

// This ensures that only one copy of our app can run at once.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  const fs = require('fs');
  const bootstrap = require('./updater/build/bootstrap.js');
  const uuid = require('uuid/v4');
  const semver = require('semver');
  const windowStateKeeper = require('electron-window-state');
  const pid = require('process').pid;
  const crashHandler = require('crash-handler');

  app.commandLine.appendSwitch('force-ui-direction', 'ltr');

  /* Determine the current release channel we're
   * on based on name. The channel will always be
   * the premajor identifier, if it exists.
   * Otherwise, default to latest. */
  const releaseChannel = (() => {
    const components = semver.prerelease(pjson.version);

    if (components) return components[0];
    return 'latest';
  })();

  ////////////////////////////////////////////////////////////////////////////////
  // Main Program
  ////////////////////////////////////////////////////////////////////////////////

  (function setupLogger() {
    // save logs to the cache directory
    electronLog.transports.file.file = path.join(app.getPath('userData'), 'log.log');
    electronLog.transports.file.level = 'info';
    // Set approximate maximum log size in bytes. When it exceeds,
    // the archived log will be saved as the log.old.log file
    electronLog.transports.file.maxSize = 5 * 1024 * 1024;

    // catch and log unhandled errors/rejected promises
    electronLog.catchErrors();

    // network logging is disabled by default
    if (!process.argv.includes('--network-logging')) return;
    app.on('ready', () => {

      // ignore fs requests
      const filter = { urls: ['https://*', 'http://*'] };

      session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
        log('HTTP REQUEST', details.method, details.url);
        callback(details);
      });

      session.defaultSession.webRequest.onErrorOccurred(filter, (details) => {
        log('HTTP REQUEST FAILED', details.method, details.url);
      });

      session.defaultSession.webRequest.onCompleted(filter, (details) => {
        log('HTTP REQUEST COMPLETED', details.method, details.url, details.statusCode);
      });
    });
  })();

  function log(...args) {
    if (!process.env.SLOBS_DISABLE_MAIN_LOGGING) {
      electronLog.log(...args);
    }
  }

  // Windows
  let workerWindow;
  let mainWindow;
  let childWindow;

  // Somewhat annoyingly, this is needed so that the main window
  // can differentiate between a user closing it vs the app
  // closing the windows before exit.
  let allowMainWindowClose = false;
  let shutdownStarted = false;
  let appShutdownTimeout;

  global.indexUrl = 'file://' + __dirname + '/index.html';

  function openDevTools() {
    childWindow.webContents.openDevTools({ mode: 'undocked' });
    mainWindow.webContents.openDevTools({ mode: 'undocked' });
    workerWindow.webContents.openDevTools({ mode: 'undocked' });
  }

  // TODO: Clean this up
  // These windows are waiting for services to be ready
  let waitingVuexStores = [];
  let workerInitFinished = false;

  function startApp() {
    const isDevMode = (process.env.NODE_ENV !== 'production') && (process.env.NODE_ENV !== 'test');
    let crashHandlerLogPath = "";
    if (process.env.NODE_ENV !== 'production' || !!process.env.SLOBS_PREVIEW) {
      crashHandlerLogPath = app.getPath('userData');
    }

    crashHandler.startCrashHandler(app.getAppPath(), process.env.SLOBS_VERSION, isDevMode.toString(), crashHandlerLogPath);
    crashHandler.registerProcess(pid, false);

    const Raven = require('raven');

    function handleFinishedReport() {
      dialog.showErrorBox('Something Went Wrong',
      'An unexpected error occured and Streamlabs OBS must be shut down.\n' +
      'Please restart the application.');

      app.exit();
    }

    if (pjson.env === 'production') {

      Raven.config('https://6971fa187bb64f58ab29ac514aa0eb3d@sentry.io/251674', {
        release: process.env.SLOBS_VERSION
      }).install(function (err, initialErr, eventId) {
        handleFinishedReport();
      });

      crashReporter.start({
        productName: 'streamlabs-obs',
        companyName: 'streamlabs',
        ignoreSystemCrashHandler: true,
        submitURL:
          'https://sentry.io/api/1283430/minidump/' +
          '?sentry_key=01fc20f909124c8499b4972e9a5253f2',
        extra: {
          'sentry[release]': pjson.version,
          processType: 'main',
        }
      });
    }

    workerWindow = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true }
    });

    // setTimeout(() => {
      workerWindow.loadURL(`${global.indexUrl}?windowId=worker`);
    // }, 10 * 1000);

    // All renderers should use ipcRenderer.sendTo to send to communicate with
    // the worker.  This still gets proxied via the main process, but eventually
    // we will refactor this to not use electron IPC, which will make it much
    // more efficient.
    ipcMain.on('getWorkerWindowId', event => {
      event.returnValue = workerWindow.webContents.id;
    });

    const mainWindowState = windowStateKeeper({
      defaultWidth: 1600,
      defaultHeight: 1000
    });

    mainWindow = new BrowserWindow({
      minWidth: 800,
      minHeight: 600,
      width: mainWindowState.width,
      height: mainWindowState.height,
      x: mainWindowState.x,
      y: mainWindowState.y,
      show: false,
      frame: false,
      title: 'Streamlabs OBS',
      backgroundColor: '#17242D',
      webPreferences: { nodeIntegration: true, webviewTag: true }
    });

    // setTimeout(() => {
      mainWindow.loadURL(`${global.indexUrl}?windowId=main`);
    // }, 5 * 1000)

    mainWindowState.manage(mainWindow);

    mainWindow.removeMenu();

    mainWindow.on('close', e => {
      if (!shutdownStarted) {
        shutdownStarted = true;
        workerWindow.send('shutdown');

        // We give the worker window 10 seconds to acknowledge a request
        // to shut down.  Otherwise, we just close it.
        appShutdownTimeout = setTimeout(() => {
          allowMainWindowClose = true;
          if (!mainWindow.isDestroyed()) mainWindow.close();
          if (!workerWindow.isDestroyed()) workerWindow.close();
        }, 10 * 1000);
      }

      if (!allowMainWindowClose) e.preventDefault();
    });

    // prevent worker window to be closed before other windows
    // we need it to properly handle App.stop() in tests
    // since it tries to close all windows
    workerWindow.on('close', e => {
      if (!shutdownStarted) {
        e.preventDefault();
        mainWindow.close();
      }
    });

    ipcMain.on('acknowledgeShutdown', () => {
      if (appShutdownTimeout) clearTimeout(appShutdownTimeout);
    });

    ipcMain.on('shutdownComplete', () => {
      allowMainWindowClose = true;
      mainWindow.close();
      workerWindow.close();
    });

    // Initialize the keylistener
    require('node-libuiohook').startHook();

    workerWindow.on('closed', () => {
      require('node-libuiohook').stopHook();
      session.defaultSession.flushStorageData();
      session.defaultSession.cookies.flushStore(() => app.quit());
    });

    // Pre-initialize the child window
    childWindow = new BrowserWindow({
      show: false,
      frame: false,
      backgroundColor: '#17242D',
      webPreferences: { nodeIntegration: true }
    });

    childWindow.removeMenu();

    childWindow.loadURL(`${global.indexUrl}?windowId=child`);

    // The child window is never closed, it just hides in the
    // background until it is needed.
    childWindow.on('close', e => {
      if (!shutdownStarted) {
        childWindow.send('closeWindow');

        // Prevent the window from actually closing
        e.preventDefault();
      }
    });

    if (process.env.SLOBS_PRODUCTION_DEBUG) openDevTools();

    // simple messaging system for services between windows
    // WARNING! renderer windows use synchronous requests and will be frozen
    // until the worker window's asynchronous response
    const requests = { };

    function sendRequest(request, event = null, async = false) {
      workerWindow.webContents.send('services-request', request);
      if (!event) return;
      requests[request.id] = Object.assign({}, request, { event, async });
    }

    // use this function to call some service method from the main process
    function callService(resource, method, ...args) {
      sendRequest({
        jsonrpc: '2.0',
        method,
        params: {
          resource,
          args
        }
      });
    }

    ipcMain.on('AppInitFinished', () => {
      workerInitFinished = true;

      BrowserWindow.getAllWindows().forEach(window => window.send('initFinished'));

      waitingVuexStores.forEach(windowId => {
        workerWindow.webContents.send('vuex-sendState', windowId);
      });
    });

    ipcMain.on('services-request', (event, payload) => {
      sendRequest(payload, event);
    });

    ipcMain.on('services-request-async', (event, payload) => {
      sendRequest(payload, event, true);
    });

    ipcMain.on('services-response', (event, response) => {
      if (!requests[response.id]) return;

      if (requests[response.id].async) {
        requests[response.id].event.reply('services-response-async', response);
      } else {
        requests[response.id].event.returnValue = response;
      }
      delete requests[response.id];
    });

    ipcMain.on('services-message', (event, payload) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(window => {
        if (window.id === workerWindow.id || window.isDestroyed()) return;
        window.webContents.send('services-message', payload);
      });
    });

    if (isDevMode) {
      require('devtron').install();

      // Vue dev tools appears to cause strange non-deterministic
      // interference with certain NodeJS APIs, expecially asynchronous
      // IO from the renderer process.  Enable at your own risk.

      // const devtoolsInstaller = require('electron-devtools-installer');
      // devtoolsInstaller.default(devtoolsInstaller.VUEJS_DEVTOOLS);

      // setTimeout(() => {
      //   openDevTools();
      // }, 10 * 1000);
    }
  }

  const haDisableFile = path.join(app.getPath('userData'), 'HADisable');
  if (fs.existsSync(haDisableFile)) app.disableHardwareAcceleration();

  app.setAsDefaultProtocolClient('slobs');

  app.on('second-instance', (event, argv, cwd) => {
    // Check for protocol links in the argv of the other process
    argv.forEach(arg => {
      if (arg.match(/^slobs:\/\//)) {
        mainWindow.send('protocolLink', arg);
      }
    });

    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();
    }
  });

  app.on('ready', () => {
    if (
      !process.argv.includes('--skip-update') &&
      ((process.env.NODE_ENV === 'production') || process.env.SLOBS_FORCE_AUTO_UPDATE)) {
      const updateInfo = {
        baseUrl: 'https://slobs-cdn.streamlabs.com',
        version: pjson.version,
        exec: process.argv,
        cwd: process.cwd(),
        waitPids: [ process.pid ],
        appDir: path.dirname(app.getPath('exe')),
        tempDir: path.join(app.getPath('temp'), 'slobs-updater'),
        cacheDir: app.getPath('userData'),
        versionFileName: `${releaseChannel}.json`
      };

      bootstrap(updateInfo, startApp, app.exit);
    } else {
      startApp();
    }
  });

  ipcMain.on('openDevTools', () => {
    openDevTools();
  });


  ipcMain.on('window-closeChildWindow', (event) => {
    // never close the child window, hide it instead
    if (!childWindow.isDestroyed()) childWindow.hide();
  });


  ipcMain.on('window-focusMain', () => {
    if (!mainWindow.isDestroyed()) mainWindow.focus();
  });

  // The main process acts as a hub for various windows
  // syncing their vuex stores.
  let registeredStores = {};

  ipcMain.on('vuex-register', event => {
    let win = BrowserWindow.fromWebContents(event.sender);
    let windowId = win.id;

    // Register can be received multiple times if the window is
    // refreshed.  We only want to register it once.
    if (!registeredStores[windowId]) {
      registeredStores[windowId] = win;
      log('Registered vuex stores: ', Object.keys(registeredStores));

      // Make sure we unregister is when it is closed
      win.on('closed', () => {
        delete registeredStores[windowId];
        log('Registered vuex stores: ', Object.keys(registeredStores));
      });
    }

    if (windowId !== workerWindow.id) {
      // Tell the worker window to send its current store state
      // to the newly registered window

      if (workerInitFinished) {
        workerWindow.webContents.send('vuex-sendState', windowId);
      } else {
        waitingVuexStores.push(windowId);
      }
    }
  });

  // Proxy vuex-mutation events to all other subscribed windows
  ipcMain.on('vuex-mutation', (event, mutation) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    if (senderWindow && !senderWindow.isDestroyed()) {
      const windowId = senderWindow.id;

      Object.keys(registeredStores).filter(id => id !== windowId.toString()).forEach(id => {
        const win = registeredStores[id];
        if (!win.isDestroyed()) win.webContents.send('vuex-mutation', mutation);
      });
    }
  });

  ipcMain.on('restartApp', () => {
    app.relaunch();
    // Closing the main window starts the shut down sequence
    mainWindow.close();
  });

  ipcMain.on('streamlabels-writeFile', (e, info) => {
    fs.writeFile(info.path, info.data, err => {
      if (err) {
        console.log('Streamlabels: Error writing file', err);
      }
    });
  });

  /* The following 3 methods need to live in the main process
     because events bound using the remote module are not
     executed synchronously and therefore default actions
     cannot be prevented. */
  ipcMain.on('webContents-preventNavigation', (e, id) => {
    const contents = webContents.fromId(id);

    if (contents.isDestroyed()) return;

    contents.on('will-navigate', e => {
      e.preventDefault();
    });
  });

  ipcMain.on('webContents-preventPopup', (e, id) => {
    const contents = webContents.fromId(id);

    if (contents.isDestroyed()) return;

    contents.on('new-window', e => {
      e.preventDefault();
    });
  });

  ipcMain.on('webContents-bindYTChat', (e, id) => {
    const contents = webContents.fromId(id);

    if (contents.isDestroyed()) return;

    contents.on('will-navigate', (e, targetUrl) => {
      const url = require('url');
      const parsed = url.parse(targetUrl);

      if (parsed.hostname === 'accounts.google.com') {
        e.preventDefault();
      }
    });
  });

  ipcMain.on('getMainWindowWebContentsId', e => {
    e.returnValue = mainWindow.webContents.id;
  });

  ipcMain.on('requestPerformanceStats', e => {
    const stats = app.getAppMetrics();
    e.sender.send('performanceStatsResponse', stats);
  });

  ipcMain.on('showErrorAlert', () => {
    if (!mainWindow.isDestroyed()) { // main window may be destroyed on shutdown
      mainWindow.send('showErrorAlert');
    }
  });

  ipcMain.on('gameOverlayPaintCallback', (e, { contentsId, overlayId }) => {
    const contents = webContents.fromId(contentsId);

    if (contents.isDestroyed()) return;

    contents.on('paint', (event, dirty, image) => {
      if (
        overlay.paintOverlay(
          overlayId,
          image.getSize().width,
          image.getSize().height,
          image.getBitmap(),
        ) === 0
      ) {
        contents.invalidate();
      }
    });
  });

  ipcMain.on('getWindowIds', e => {
    e.returnValue = {
      worker: workerWindow.id,
      main: mainWindow.id,
      child: childWindow.id,
    };
  });

  let lastEventTime = 0;
  ipcMain.on('measure-time', (e, msg, time) => {
    const delta = lastEventTime ? time - lastEventTime : 0;
    lastEventTime = time;
    if (delta > 2000) console.log('------------------');
    console.log(msg, delta + 'ms');
  });
}
