// Every user-initiated extension install goes through the install prompt
// (ExtensionInstallDialog, mounted by App), which shows what the extension
// can do and installs only on "Add extension" — like Chrome's dialog.

export type InstallOutcome = 'installed' | 'cancelled'

type InstallHandler = (idOrUrl: string) => Promise<InstallOutcome>

let handler: InstallHandler | null = null

/** App registers the prompt; null unregisters. */
export function setExtensionInstallHandler(next: InstallHandler | null): void {
  handler = next
}

/** Ask to install an extension by Web Store URL or id. Resolves when the
 *  prompt closes; rejects if the extension couldn't be fetched or
 *  installed. */
export function requestExtensionInstall(idOrUrl: string): Promise<InstallOutcome> {
  if (!handler) return Promise.reject(new Error('The install prompt is not available in this window.'))
  return handler(idOrUrl)
}
