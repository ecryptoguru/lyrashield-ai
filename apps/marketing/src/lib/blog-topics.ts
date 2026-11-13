import images from "../content/blog-images/images.json"

export type BlogTopic =
  | "vibe-coding-security"
  | "access-control"
  | "web-security"
  | "supply-chain"
  | "agent-security"
  | "verification"
const clusterTopics: Record<string, BlogTopic> = {
  authority: "vibe-coding-security",
  "access-control": "access-control",
  "web-execution": "web-security",
  "supply-chain": "supply-chain",
  "agent-security": "agent-security",
  verification: "verification",
  "decision-operations": "verification",
}

/** One browsing topic from the existing editorial image cluster; secondary tags stay intact. */
export function primaryBlogTopic(data: {
  tags: readonly BlogTopic[]
  heroImage: { id: string }
}): BlogTopic {
  const image = images[data.heroImage.id as keyof typeof images]
  const topic = image ? clusterTopics[image.cluster] : undefined
  return topic && data.tags.includes(topic)
    ? topic
    : (data.tags.find((tag) => tag !== "vibe-coding-security" && tag !== "verification") ??
        data.tags[0] ??
        "vibe-coding-security")
}
