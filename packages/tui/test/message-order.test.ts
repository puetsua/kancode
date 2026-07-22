import { describe, expect, test } from "bun:test"
import { orderTurnMessages } from "../src/util/message-order"

describe("orderTurnMessages", () => {
  test("moves mid-turn queued user after completed open-turn assistants", () => {
    const msgs = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant", parentID: "u1" },
      { id: "u2", role: "user" }, // queued mid-turn
      { id: "a2", role: "assistant", parentID: "u1" },
      { id: "a3", role: "assistant", parentID: "u1" },
      { id: "a4", role: "assistant", parentID: "u2" },
    ]
    expect(orderTurnMessages(msgs).map((m) => m.id)).toEqual(["u1", "a1", "a2", "a3", "u2", "a4"])
  })
})
