import { useState, useEffect } from 'react'
import { X, Lock, Unlock, ShieldAlert, ChevronDown, ChevronRight } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'

interface CertInfo {
  subject: { CN?: string; O?: string; OU?: string }
  issuer: { CN?: string; O?: string; OU?: string }
  validFrom: string
  validTo: string
  serialNumber: string
  fingerprint256: string
  pubkeyFingerprint?: string
  subjectAltNames?: string
  protocol?: string
  cipher?: string
}

interface Props {
  open: boolean
  url: string
  security: 'secure' | 'insecure' | 'warning' | 'internal'
  onClose: () => void
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return dateStr
  }
}

function formatFingerprint(fp: string): string {
  if (fp.includes(':')) return fp.toLowerCase()
  return fp.replace(/(.{2})(?=.)/g, '$1:').toLowerCase()
}

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-1">
      <span className="text-muted-foreground text-xs w-[160px] shrink-0">{label}</span>
      <span className="text-xs text-foreground break-all">{value}</span>
    </div>
  )
}

export function CertificatePopup({ open, url, security, onClose }: Props) {
  const [cert, setCert] = useState<CertInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!url || !url.startsWith('https://')) {
      setCert(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setCert(null)
    window.electronAPI.getCertInfo(url).then((info: any) => {
      setCert(info)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [open, url])

  useEffect(() => {
    if (open) setShowDetails(false)
  }, [open])

  if (!open) return null

  const isSecure = security === 'secure'
  const isHttp = security === 'insecure'
  const isWarning = security === 'warning'

  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    // ignore parse errors
  }

  const title = hostname ? `Certificate - ${hostname}` : 'Certificate - Newbro'

  return (
    <DetachedWindow open={open} title={title} width={430} height={620} onClose={onClose}>
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {isSecure && <Lock size={16} className="text-green-500" />}
            {isHttp && <Unlock size={16} className="text-muted-foreground" />}
            {isWarning && <ShieldAlert size={16} className="text-red-500" />}
            <span className="text-sm font-semibold text-foreground">
              {isSecure ? 'Connection is secure' : isWarning ? 'Certificate error' : 'Connection is not secure'}
            </span>
          </div>
          <button onClick={onClose} className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent text-muted-foreground">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 border-b border-border">
            {isHttp && (
              <p className="text-xs text-muted-foreground">
                This site is using an unencrypted HTTP connection. Information you submit (passwords, messages, etc.) could be read by others.
              </p>
            )}
            {isSecure && (
              <p className="text-xs text-muted-foreground">
                Your connection to <span className="font-medium text-foreground">{hostname}</span> is encrypted using TLS.
                {cert?.protocol && <> Protocol: <span className="font-mono text-foreground">{cert.protocol}</span>.</>}
                {cert?.cipher && <> Cipher: <span className="font-mono text-foreground">{cert.cipher}</span>.</>}
              </p>
            )}
            {isWarning && (
              <p className="text-xs text-red-400">
                The certificate for this site is not valid. An attacker could intercept your connection.
              </p>
            )}
          </div>

          {url.startsWith('https://') && (
            <div className="px-4 py-3">
              {loading && <p className="text-xs text-muted-foreground">Loading certificate...</p>}
              {!loading && !cert && <p className="text-xs text-muted-foreground">Could not retrieve certificate information.</p>}
              {cert && (
                <>
                  <div className="mb-3">
                    <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Issued To</h4>
                    <Row label="Common Name (CN)" value={cert.subject.CN} />
                    <Row label="Organization (O)" value={cert.subject.O} />
                    <Row label="Organizational Unit (OU)" value={cert.subject.OU || '<Not Part Of Certificate>'} />
                  </div>

                  <div className="mb-3">
                    <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Issued By</h4>
                    <Row label="Common Name (CN)" value={cert.issuer.CN} />
                    <Row label="Organization (O)" value={cert.issuer.O} />
                    <Row label="Organizational Unit (OU)" value={cert.issuer.OU || '<Not Part Of Certificate>'} />
                  </div>

                  <div className="mb-2">
                    <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Validity Period</h4>
                    <Row label="Issued On" value={formatDate(cert.validFrom)} />
                    <Row label="Expires On" value={formatDate(cert.validTo)} />
                  </div>

                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    className="flex items-center gap-1 text-xs text-primary hover:underline mt-2"
                  >
                    {showDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Details
                  </button>

                  {showDetails && (
                    <div className="mt-2 pt-2 border-t border-border">
                      {cert.serialNumber && (
                        <div className="mb-3">
                          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Serial Number</h4>
                          <p className="text-xs font-mono text-foreground break-all">{cert.serialNumber.toLowerCase()}</p>
                        </div>
                      )}

                      {cert.subjectAltNames && (
                        <div className="mb-3">
                          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Subject Alternative Names</h4>
                          <p className="text-xs font-mono text-foreground break-all">
                            {cert.subjectAltNames.replace(/DNS:/g, '').split(',').map((s) => s.trim()).join(', ')}
                          </p>
                        </div>
                      )}

                      <div className="mb-3">
                        <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">SHA-256 Fingerprint</h4>
                        <p className="text-xs font-mono text-foreground break-all">{formatFingerprint(cert.fingerprint256)}</p>
                      </div>

                      {cert.pubkeyFingerprint && (
                        <div className="mb-1">
                          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Public Key Fingerprint</h4>
                          <p className="text-xs font-mono text-foreground break-all">{formatFingerprint(cert.pubkeyFingerprint)}</p>
                        </div>
                      )}

                      {cert.protocol && (
                        <div className="mt-3 mb-1">
                          <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Connection</h4>
                          <Row label="Protocol" value={cert.protocol} />
                          <Row label="Cipher Suite" value={cert.cipher} />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </DetachedWindow>
  )
}
