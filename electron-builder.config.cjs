/** Runtime files are allowlisted; local notes, credentials and caches never ship. */
module.exports = {
  appId: 'io.github.wang-honghzhen.tuji',
  productName: '图记',
  electronDist: 'node_modules/electron/dist',
  directories: { app: '.', output: 'release' },
  files: [
    'package.json',
    'desktop/main.mjs',
    'scripts/credential-storage.mjs',
    'dist/**/*',
    'dist-ai/*.cjs',
  ],
  asar: true,
  // Node workers and native PDF/OCR libraries require real filesystem paths.
  asarUnpack: ['dist-ai/*.cjs', 'node_modules/**/*'],
  extraResources: [{ from: '.cache/desktop/ocr', to: 'ocr' }],
  // Canvas uses its shipped Node-API binary, not Electron's version-specific ABI.
  npmRebuild: false,
  win: {
    executableName: 'Tuji',
    icon: 'public/brand/tree.png',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Tuji-${version}-win-${arch}-setup.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '图记',
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
  },
};
