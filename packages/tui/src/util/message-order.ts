/** Minimal message shape needed to keep turn tool chains contiguous. */
export type TurnOrderMessage = {
  id: string
  role: string
  parentID?: string
}

/**
 * Queued users are persisted mid-turn (ID between open-turn assistants).
 * Render each turn's assistants contiguously, then append unanswered users
 * so the transcript matches Codex-like "continue from end of last turn".
 */
export function orderTurnMessages<T extends TurnOrderMessage>(msgs: T[]): T[] {
  const ordered: T[] = []
  const placedUsers = new Set<string>()
  for (const msg of msgs) {
    if (msg.role === "assistant") {
      if (msg.parentID && !placedUsers.has(msg.parentID)) {
        const parent = msgs.find((m) => m.role === "user" && m.id === msg.parentID)
        if (parent) {
          ordered.push(parent)
          placedUsers.add(msg.parentID)
        }
      }
      ordered.push(msg)
      continue
    }
    if (msg.role === "user") continue
    ordered.push(msg)
  }
  for (const msg of msgs) {
    if (msg.role === "user" && !placedUsers.has(msg.id)) {
      ordered.push(msg)
      placedUsers.add(msg.id)
    }
  }
  return ordered
}

/** Badge copy for a user message waiting behind an open turn. */
export function pendingDeliveryBadge(delivery?: "steer" | "queue") {
  return delivery === "queue" ? " QUEUED " : " STEERING "
}

/**
 * True while another turn is still open and this user has not started yet.
 * Queued users can have mid-turn IDs (older than the pending assistant), so
 * `id > pending` alone is not enough — honor `delivery: "queue"` as well.
 */
export function isWaitingUserMessage(input: {
  messageID: string
  delivery?: "steer" | "queue"
  pendingAssistantID?: string
  messages: Array<{ id: string; role: string; parentID?: string }>
}) {
  const pendingID = input.pendingAssistantID
  if (!pendingID) return false

  const pending = input.messages.find((m) => m.id === pendingID)
  if (!pending || pending.role !== "assistant") return false
  if (pending.parentID === input.messageID) return false
  if (input.messages.some((m) => m.role === "assistant" && m.parentID === input.messageID)) return false

  return input.messageID > pendingID || input.delivery === "queue"
}
