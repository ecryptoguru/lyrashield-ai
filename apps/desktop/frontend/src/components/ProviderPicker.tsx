interface Props {
  onSelect: (provider: "chatgpt" | "azure") => void
}

export function ProviderPicker({ onSelect }: Props) {
  return (
    <div className="space-y-3">
      <button
        onClick={() => onSelect("chatgpt")}
        className="w-full rounded-md border border-border p-4 text-left hover:bg-accent"
      >
        <p className="text-sm font-medium text-foreground">ChatGPT Subscription</p>
        <p className="text-xs text-muted-foreground">
          Sign in with your ChatGPT Plus/Pro account. No API key needed.
        </p>
      </button>
      <button
        onClick={() => onSelect("azure")}
        className="w-full rounded-md border border-border p-4 text-left hover:bg-accent"
      >
        <p className="text-sm font-medium text-foreground">Azure OpenAI</p>
        <p className="text-xs text-muted-foreground">
          Use your Azure OpenAI deployment. API key + endpoint required.
        </p>
      </button>
    </div>
  )
}
