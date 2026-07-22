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
