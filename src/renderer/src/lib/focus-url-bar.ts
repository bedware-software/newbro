// Cmd/Ctrl+L, Focus Address, a new tab set to land on the address: the
// address editor (components/UrlEditor.tsx), where every edit of the address
// happens, opened as a click on the address bar opens it. Main brings the
// keyboard to this window first: a tab's page, a native view of its own,
// may be holding it.
import { openUrlEditor } from './url-editor'

export function focusAndSelectUrlBar(): void {
  window.electronAPI?.focusWindowRenderer?.()
  openUrlEditor('click')
}
