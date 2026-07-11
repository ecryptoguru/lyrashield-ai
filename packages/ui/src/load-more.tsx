"use client"

import { useState, useCallback } from "react"
import { Button, Spinner } from "./"

interface LoadMoreProps<T> {
  /** Fetch the next page. Returns items + nextCursor. */
  onLoadMore: (cursor: string) => Promise<{ items: T[]; nextCursor: string | null }>
  /** Current cursor to start from. */
  cursor: string | null
  /** Callback when new items are loaded. */
  onItems: (items: T[]) => void
  /** Called when the next cursor is determined (null = no more pages). */
  onNextCursor: (cursor: string | null) => void
  /** Label for the button. */
  label?: string
}

export function LoadMore<T>({
  onLoadMore,
  cursor,
  onItems,
  onNextCursor,
  label = "Load more",
}: LoadMoreProps<T>) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = useCallback(async () => {
    if (!cursor || loading) return
    setLoading(true)
    setError(null)
    try {
      const { items, nextCursor } = await onLoadMore(cursor)
      onItems(items)
      onNextCursor(nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more")
    } finally {
      setLoading(false)
    }
  }, [cursor, loading, onLoadMore, onItems, onNextCursor])

  if (!cursor) return null

  return (
    <div className="flex flex-col items-center gap-2 pt-4">
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <Button
        variant="secondary"
        onClick={handleClick}
        disabled={loading}
        aria-busy={loading}
        aria-label={label}
      >
        {loading ? <Spinner className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
        {loading ? "Loading..." : label}
      </Button>
    </div>
  )
}
