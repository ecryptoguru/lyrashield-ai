import type { LucideIcon } from "lucide-react"
import { Card, cn } from "@lyrashield/ui"
import { getTrendPointX } from "./security-visuals.utils"

const severityColors: Record<string, string> = {
  CRITICAL: "var(--color-critical)",
  HIGH: "oklch(0.64 0.19 42)",
  MEDIUM: "var(--color-warning)",
  LOW: "var(--color-chart-1)",
  INFO: "var(--color-muted-foreground)",
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: string | number
  detail: string
  icon: LucideIcon
}) {
  return (
    <Card className="relative overflow-hidden p-5">
      <div className="via-primary/50 absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.1em] uppercase">
            {label}
          </p>
          <p className="metric-number mt-2 text-3xl font-bold">{value}</p>
          <p className="text-muted-foreground mt-1 text-xs">{detail}</p>
        </div>
        <div className="bg-primary/8 text-primary flex size-10 items-center justify-center rounded-xl">
          <Icon className="size-5" aria-hidden="true" />
        </div>
      </div>
    </Card>
  )
}

export function ScoreGauge({ score, grade }: { score: number | null; grade?: string | null }) {
  const value = score ?? 0
  const circumference = 2 * Math.PI * 48
  const offset = circumference - (value / 100) * circumference
  const color =
    score === null
      ? "var(--color-muted-foreground)"
      : score >= 80
        ? "var(--color-success)"
        : score >= 40
          ? "var(--color-warning)"
          : "var(--color-critical)"

  return (
    <div
      className="relative flex size-36 shrink-0 items-center justify-center"
      role="img"
      aria-label={
        score === null ? "Security score not yet available" : `Security score ${score} out of 100`
      }
    >
      <svg className="size-36 -rotate-90" viewBox="0 0 112 112" aria-hidden="true">
        <circle cx="56" cy="56" r="48" fill="none" stroke="var(--color-muted)" strokeWidth="8" />
        <circle
          cx="56"
          cy="56"
          r="48"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute text-center">
        <span className="metric-number block text-4xl font-bold">{score ?? "—"}</span>
        <span className="text-muted-foreground text-xs font-semibold tracking-[0.14em] uppercase">
          {grade ? grade.replace("_PLUS", "+") : "Pending"}
        </span>
      </div>
    </div>
  )
}

export function SeverityDonut({ values }: { values: Record<string, number> }) {
  const entries = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((severity) => ({
    severity,
    count: values[severity] ?? 0,
  }))
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const radius = 42
  const circumference = 2 * Math.PI * radius
  let accumulated = 0

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div
        className="relative flex size-32 shrink-0 items-center justify-center"
        role="img"
        aria-label={`${total} findings by severity`}
      >
        <svg className="size-32 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="var(--color-muted)"
            strokeWidth="12"
          />
          {total > 0 &&
            entries.map((entry) => {
              const length = (entry.count / total) * circumference
              const offset = -accumulated
              accumulated += length
              return (
                <circle
                  key={entry.severity}
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke={severityColors[entry.severity]}
                  strokeWidth="12"
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={offset}
                />
              )
            })}
        </svg>
        <span className="metric-number absolute text-2xl font-bold">{total}</span>
      </div>
      <div className="grid w-full grid-cols-2 gap-x-5 gap-y-2">
        {entries.map((entry) => (
          <div key={entry.severity} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground flex items-center gap-2">
              <span
                className="size-2 rounded-full"
                style={{ background: severityColors[entry.severity] }}
                aria-hidden="true"
              />
              {entry.severity}
            </span>
            <span className="metric-number font-semibold">{entry.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ScoreTrend({ points }: { points: Array<{ label: string; score: number }> }) {
  const width = 560
  const height = 180
  const inset = 18
  const usableHeight = height - inset * 2
  const coords = points.map((point, index) => ({
    ...point,
    x: getTrendPointX(index, points.length, width, inset),
    y: inset + ((100 - point.score) / 100) * usableHeight,
  }))
  const path = coords.map((point) => `${point.x},${point.y}`).join(" ")

  if (points.length === 0) {
    return (
      <div className="text-muted-foreground flex h-44 items-center justify-center text-sm">
        Complete a scan to establish the score trend.
      </div>
    )
  }

  return (
    <div role="img" aria-label={`Security score trend across ${points.length} completed scans`}>
      <svg
        className="h-44 w-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = inset + ((100 - tick) / 100) * usableHeight
          return (
            <line
              key={tick}
              x1={inset}
              x2={width - inset}
              y1={y}
              y2={y}
              stroke="var(--color-border)"
              strokeDasharray="4 6"
            />
          )
        })}
        <polyline
          points={path}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="3"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {coords.map((point) => (
          <circle
            key={`${point.label}-${point.x}`}
            cx={point.x}
            cy={point.y}
            r="4"
            fill="var(--color-primary)"
          />
        ))}
      </svg>
      <div className="text-muted-foreground mt-1 flex items-center justify-between text-[11px]">
        <span>{points[0]?.label}</span>
        <span>Latest {points.at(-1)?.score}/100</span>
      </div>
    </div>
  )
}

export function RemediationBars({
  rows,
}: {
  rows: Array<{ label: string; value: number; tone?: "primary" | "success" | "warning" }>
}) {
  const total = Math.max(
    1,
    rows.reduce((sum, row) => sum + row.value, 0)
  )
  const tones = {
    primary: "bg-primary",
    success: "bg-success",
    warning: "bg-warning",
  }

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground font-medium">{row.label}</span>
            <span className="metric-number font-semibold">{row.value}</span>
          </div>
          <div className="bg-muted h-2.5 overflow-hidden rounded-full">
            <div
              className={cn("h-full rounded-full", tones[row.tone ?? "primary"])}
              style={{ width: `${Math.max(row.value > 0 ? 4 : 0, (row.value / total) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
