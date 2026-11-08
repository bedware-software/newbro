// Names the extension machinery went by while the app was called Newbro.
//
// Extension folders are patched in place, so the first Vimperium launch
// finds files, markers and manifest entries the Newbro build wrote. Each
// one has to be recognised as ours and replaced, or both versions of a
// shim run side by side (Vimium loses its storage, Tampermonkey's
// bootstraps run twice). The runtime names stay accepted for a while
// longer: Chromium can wake an extension's cached, Newbro-patched service
// worker once more before the rewritten one takes over, and that worker
// still calls home by the old names.

/** Content-script entries Newbro declared for a userscript manager's
 *  bootstraps carry this key instead of ours. */
export const LEGACY_BOOTSTRAP_MARKER = '__newbro_bootstrap__'

/** Newbro's content-script storage polyfill, listed first in every
 *  content_scripts[].js. Dropped from the list and deleted. */
export const LEGACY_CS_STORAGE_POLYFILL_FILENAME = 'newbro-cs-storage.js'

/** The port that polyfill (and the frame bridge below) opens to the
 *  service worker. The worker shim answers it too, for a page still
 *  running the old polyfill — and our own polyfill and frame bridge
 *  connect by this name for now (manager.ts CS_STORAGE_CONNECT_PORT):
 *  a profile's cached Newbro-era worker answers no other until the
 *  profile drops it. */
export const LEGACY_CS_STORAGE_PORT = '__newbro_cs_storage'

/** Newbro's frame storage bridge: its <script> tag is stripped from every
 *  extension page and the file deleted. */
export const LEGACY_FRAME_STORAGE_BRIDGE_FILENAME = 'newbro-frame-storage.js'
export const LEGACY_FRAME_STORAGE_BRIDGE_TAG = `<script src="/${LEGACY_FRAME_STORAGE_BRIDGE_FILENAME}"></script>`

/** Newbro's service-worker shim: header prefix (any version), the V1
 *  header (no footer, ends at its IIFE), the footer, and the sibling
 *  module that module workers imported. The strip removes the old shim
 *  before ours goes in; the module is deleted once nothing imports it. */
export const LEGACY_SW_SHIM_HEADER_PREFIX = '// __NEWBRO_SW_SHIM_'
export const LEGACY_SW_SHIM_V1_MAGIC = '// __NEWBRO_SW_SHIM_V1__'
export const LEGACY_SW_SHIM_FOOTER = '// __NEWBRO_SW_SHIM_END__'
export const LEGACY_SW_SHIM_MODULE_FILE = 'newbro-sw-shim.js'

/** The extension's manifest as published, saved by Newbro under this
 *  name. Renamed rather than re-fetched: the backfill would otherwise
 *  download every extension again, and unpacked or offline ones would
 *  lose theirs for good. */
export const LEGACY_ORIGINAL_MANIFEST_FILE = 'newbro-original-manifest.json'

/** Newbro's IPC scheme and sentinel host. Both stay registered, handled
 *  and kept out of extension proxies, so a cached Newbro worker is
 *  neither refused nor sent through a VPN. */
export const LEGACY_IPC_SCHEME = 'newbro-ipc'
export const LEGACY_IPC_HOST = 'newbro-ext-ipc.test'

/** Headers a Newbro worker sends to the loopback RPC server. The secret
 *  is the same one (it lives in userData), only the header's name is old. */
export const LEGACY_RPC_TOKEN_HEADER = 'X-Newbro-Token'
export const LEGACY_RPC_PARTITION_HEADER = 'X-Newbro-Partition'

/** Dev only: markers Newbro left at the top of the electron-chrome-extensions
 *  files it patches in node_modules. Recognised so the file isn't marked
 *  twice or reported as drifted. */
export const LEGACY_PRELOAD_PATCH_MARKER = /^\/\/ __NEWBRO_PRELOAD_PATCH_V[1-5]__\n/
export const LEGACY_LIB_PATCH_MARKER = '// __NEWBRO_LIB_PATCH_V1__'
