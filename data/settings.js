// dknr-voice libraries (repository lib/ folder), given to the function nodes by global.get()
function dknrLib(name) {
    try {
        return require('/data/projects/dknr-voice/lib/' + name + '.js');
    } catch (err) {
        console.error('[dknr-voice] lib ' + name + ' not loaded: ' + err.message);
        return null;
    }
}

module.exports = {
  flowFile: "flows.json",
  credentialSecret: "DKNR_SECRET",
  flowFilePretty: true,
  adminAuth: {
      type: "credentials",
      users: [{
          username: "DKNR_USERNAME",
          password: "DKNR_HASH",
          permissions: "*"
      }],
      sessionExpiryTime : 86400
  },
  httpAdminRoot: "/admin",
  httpNodeRoot: "/",
  uiPort: process.env.PORT || 1880,
  diagnostics: { enabled: true, ui: true, },
  runtimeState: { enabled: false, ui: false, },
  telemetry: { enabled: false },
  logging: { console: { level: "info", metrics: false, audit: false } },
  contextStorage: { default: { module: "localfilesystem" }, memoryOnly: { module: "memory" }, },
  exportGlobalContextKeys: false,
  externalModules: { autoInstall: true, autoInstallRetry: 60 },
  editorTheme: {
      page: { title: "DKNR Voice nodes" },
      header: { title: "DKNR Voice nodes", image: "/data/admin.png" },
      palette: { },
      projects: { enabled: true, workflow: { mode: "manual" } },
      codeEditor: { lib: "monaco", options: { } },
      markdownEditor: { mermaid: { enabled: true } },
      login: { image: "/data/admin.png" },
      userMenu: false,
      tours: false,
      lang: "fr",
  },
  functionExternalModules: true,
  functionTimeout: 0,
  functionGlobalContext: { lib_wyoming: dknrLib('wyoming'), lib_voice: dknrLib('voice') },
  ui: { path: "" },
  debugMaxLength: 1000,
  mqttReconnectTime: 15000,
  dashboard: { maxHttpBufferSize: 1e7 },
}