// Who made Vimperium and what it's built on, for Settings → About — each
// name there opens its page in a tab. The open-source list is what
// package.json brings in that ends up in the app (In the app) or turns the
// source into it (Build tools), plus Chromium and Node.js, which come inside
// Electron. A dependency added to package.json that ships or builds belongs
// here too. Licenses are the SPDX ids the packages' own package.json files
// give — electron-chrome-extensions is dual-licensed and Vimperium takes it
// as GPL-3.0 (main/chrome-extensions-bridge.ts).

export interface CreditLink {
  /** Stable: the control's data-vim-item ends with it. */
  id: string
  name: string
  url: string
}

export interface Credit extends CreditLink {
  /** What it does in Vimperium, in a few words. */
  role: string
  /** SPDX id. */
  license: string
}

export interface CreditGroup {
  id: 'app' | 'build'
  label: string
  credits: ReadonlyArray<Credit>
}

/** Who made it — a person and an AI, as the commits have it. */
export const AUTHORS: ReadonlyArray<CreditLink> = [
  { id: 'dmitry', name: 'Dmitry Surin', url: 'https://github.com/bedware-software' },
  { id: 'claude', name: 'Claude', url: 'https://www.anthropic.com/claude' },
]

/** Where its keys come from. */
export const INSPIRATIONS: ReadonlyArray<CreditLink> = [
  { id: 'vim', name: 'Vim', url: 'https://www.vim.org' },
  { id: 'vimium', name: 'Vimium', url: 'https://github.com/philc/vimium' },
]

export const CREDIT_GROUPS: ReadonlyArray<CreditGroup> = [
  {
    id: 'app',
    label: 'In the app',
    credits: [
      { id: 'electron', name: 'Electron', role: 'The app — Chromium and Node.js in one', license: 'MIT', url: 'https://www.electronjs.org' },
      { id: 'chromium', name: 'Chromium', role: 'The web engine, inside Electron', license: 'BSD-3-Clause', url: 'https://www.chromium.org' },
      { id: 'nodejs', name: 'Node.js', role: 'The main process, inside Electron', license: 'MIT', url: 'https://nodejs.org' },
      { id: 'react', name: 'React', role: 'The interface', license: 'MIT', url: 'https://react.dev' },
      { id: 'zustand', name: 'Zustand', role: 'Workspaces, groups and tabs in memory', license: 'MIT', url: 'https://github.com/pmndrs/zustand' },
      { id: 'immer', name: 'Immer', role: 'Changing that state', license: 'MIT', url: 'https://github.com/immerjs/immer' },
      { id: 'tailwindcss', name: 'Tailwind CSS', role: 'The styles', license: 'MIT', url: 'https://tailwindcss.com' },
      { id: 'lucide', name: 'Lucide', role: 'Icons', license: 'ISC', url: 'https://lucide.dev' },
      { id: 'dnd-kit', name: 'dnd-kit', role: 'Dragging to reorder', license: 'MIT', url: 'https://github.com/clauderic/dnd-kit' },
      { id: 'electron-chrome-extensions', name: 'electron-chrome-extensions', role: "Chrome extension APIs — @iamevan's fork", license: 'GPL-3.0', url: 'https://github.com/samuelmaddock/electron-browser-shell' },
      { id: 'electron-store', name: 'electron-store', role: 'Settings and data on disk', license: 'MIT', url: 'https://github.com/sindresorhus/electron-store' },
      { id: 'electron-updater', name: 'electron-updater', role: 'Updates from GitHub Releases', license: 'MIT', url: 'https://github.com/electron-userland/electron-builder' },
      { id: 'jsonc-parser', name: 'jsonc-parser', role: "Reading extensions' manifests", license: 'MIT', url: 'https://github.com/microsoft/node-jsonc-parser' },
      { id: 'uuid', name: 'uuid', role: 'IDs', license: 'MIT', url: 'https://github.com/uuidjs/uuid' },
      { id: 'clsx', name: 'clsx', role: 'Class names', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
      { id: 'tailwind-merge', name: 'tailwind-merge', role: 'Class names, merged', license: 'MIT', url: 'https://github.com/dcastil/tailwind-merge' },
      { id: 'electron-toolkit', name: 'Electron Toolkit', role: 'Dev and packaged builds told apart', license: 'MIT', url: 'https://github.com/alex8088/electron-toolkit' },
    ],
  },
  {
    id: 'build',
    label: 'Build tools',
    credits: [
      { id: 'typescript', name: 'TypeScript', role: 'The language', license: 'Apache-2.0', url: 'https://www.typescriptlang.org' },
      { id: 'electron-vite', name: 'electron-vite', role: 'Builds the main process, preloads and pages', license: 'MIT', url: 'https://electron-vite.org' },
      { id: 'vite', name: 'Vite', role: 'Bundler and dev server', license: 'MIT', url: 'https://vite.dev' },
      { id: 'vite-plugin-react', name: '@vitejs/plugin-react', role: 'React in Vite', license: 'MIT', url: 'https://github.com/vitejs/vite-plugin-react' },
      { id: 'electron-builder', name: 'electron-builder', role: 'The installers', license: 'MIT', url: 'https://github.com/electron-userland/electron-builder' },
      { id: 'husky', name: 'Husky', role: 'Git hooks — the version bump', license: 'MIT', url: 'https://github.com/typicode/husky' },
    ],
  },
]
