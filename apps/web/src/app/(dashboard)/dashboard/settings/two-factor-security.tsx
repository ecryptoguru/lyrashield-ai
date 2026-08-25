"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Check, Copy, ShieldCheck } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { authClient, getAuthErrorMessage } from "@lyrashield/auth"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Spinner,
} from "@lyrashield/ui"
import { PasswordInput } from "@/components/password-input"

export function TwoFactorSecurity({ enabled }: { enabled: boolean }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function beginEnrollment(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { data, error: enrollmentError } = await authClient.twoFactor.enable({
        password,
        method: "totp",
      })
      if (enrollmentError) {
        setError(getAuthErrorMessage(enrollmentError) ?? "Could not start two-factor setup.")
      } else if (data?.method === "totp") {
        setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes })
        setPassword("")
      } else {
        setError("Authenticator setup was not returned.")
      }
    } catch {
      setError("Could not start two-factor setup. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  async function finishEnrollment(event: React.FormEvent) {
    event.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from your authenticator app.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { error: verificationError } = await authClient.twoFactor.verifyTotp({
        code,
        trustDevice: false,
      })
      if (verificationError) {
        setError(getAuthErrorMessage(verificationError) ?? "Verification failed.")
        return
      }
      setSetup(null)
      router.refresh()
    } catch {
      setError("Could not verify the code. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  async function copySetup() {
    if (!setup) return
    try {
      await navigator.clipboard.writeText(
        `${setup.totpURI}\n\nBackup codes:\n${setup.backupCodes.join("\n")}`
      )
      setCopied(true)
    } catch {
      setError("Copy failed. Select and copy the setup details manually.")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <ShieldCheck className="size-5" aria-hidden="true" /> Two-factor authentication
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {enabled && !setup ? (
          <p className="text-sm" role="status">
            <Check className="text-success mr-2 inline size-4" aria-hidden="true" />
            Authenticator verification is enabled. Trusted-device bypass is disabled.
          </p>
        ) : setup ? (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">Scan with your authenticator app</p>
              <div className="w-fit rounded-md border bg-white p-2">
                <QRCodeSVG
                  value={setup.totpURI}
                  size={224}
                  marginSize={2}
                  title="Authenticator setup QR code"
                />
              </div>
              <p className="text-muted-foreground text-xs">
                Generated only in this browser. If scanning is unavailable, enter the URI manually.
              </p>
              <p className="text-sm font-medium">Manual authenticator URI</p>
              <textarea
                readOnly
                rows={4}
                value={setup.totpURI}
                aria-label="Authenticator setup URI"
                className="bg-muted w-full break-all rounded-md border p-3 font-mono text-xs"
              />
              <p className="text-sm font-medium">Save these one-time backup codes now</p>
              <ul className="grid gap-1 sm:grid-cols-2" aria-label="Backup codes">
                {setup.backupCodes.map((backupCode) => (
                  <li key={backupCode} className="bg-muted rounded px-2 py-1 font-mono text-xs">
                    {backupCode}
                  </li>
                ))}
              </ul>
              <Button type="button" variant="secondary" size="sm" onClick={copySetup}>
                <Copy className="mr-2 size-4" aria-hidden="true" />
                {copied ? "Copied" : "Copy setup details"}
              </Button>
            </div>
            <form onSubmit={finishEnrollment} className="max-w-sm space-y-3">
              <FormField label="Authenticator code" htmlFor="enrollment-code">
                <Input
                  id="enrollment-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                />
              </FormField>
              <Button type="submit" disabled={loading || code.length !== 6}>
                {loading && <Spinner className="mr-2" />} Verify and enable
              </Button>
            </form>
          </>
        ) : (
          <form onSubmit={beginEnrollment} className="max-w-sm space-y-3">
            <p className="text-muted-foreground text-sm">
              Use an authenticator app for sign-in and protected administrator actions.
            </p>
            <FormField label="Current password" htmlFor="two-factor-password">
              <PasswordInput
                id="two-factor-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
            </FormField>
            <p className="text-muted-foreground text-xs">
              Signed up with Google or GitHub and do not have a password?{" "}
              <Link href="/forgot-password" className="text-primary font-medium hover:underline">
                Set one securely by email
              </Link>
              .
            </p>
            <Button type="submit" disabled={loading || !password}>
              {loading && <Spinner className="mr-2" />} Set up authenticator
            </Button>
          </form>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert" aria-live="polite">
            {error}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Each backup code works once. Using one alerts both platform administrators and creates an
          audit entry for privileged accounts.
        </p>
      </CardContent>
    </Card>
  )
}
