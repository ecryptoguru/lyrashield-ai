"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export function CreateLinkForm({ affiliateId }: { affiliateId: string }) {
  const router = useRouter()
  const [campaign, setCampaign] = useState("")
  const [subid, setSubid] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      const response = await fetch("/affiliates/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affiliateId, campaign, subid }),
      })

      if (response.ok) {
        setCampaign("")
        setSubid("")
        router.refresh()
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2">
      <input
        type="text"
        placeholder="Campaign name (e.g. youtube-q3)"
        value={campaign}
        onChange={(e) => setCampaign(e.target.value)}
        maxLength={100}
        className="flex-1 rounded-md border px-3 py-2 text-sm"
      />
      <input
        type="text"
        placeholder="SubID (optional)"
        value={subid}
        onChange={(e) => setSubid(e.target.value)}
        maxLength={100}
        className="w-40 rounded-md border px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={loading || !campaign}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {loading ? "Creating..." : "Create Variant"}
      </button>
    </form>
  )
}
