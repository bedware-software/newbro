// Holds the page's first paint: a sync IPC that app.cjs answers after
// stallMs, as a slow site would hold it.
const { ipcRenderer } = require('electron')
ipcRenderer.sendSync('wf-stall')
