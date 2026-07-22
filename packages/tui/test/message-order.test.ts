import { describe, expect, test } from "bun:test"
import { isWaitingUserMessage, orderTurnMessages, pendingDeliveryBadge } from "../src/util/message-order"

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

describe("pending delivery badges", () => {
  const openTurn = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" }, // mid-turn queue id
    { id: "a2", role: "assistant", parentID: "u1" },
    { id: "a3", role: "assistant", parentID: "u1" }, // pending
  ]

  test("keeps QUEUED on mid-turn queue ids while the open turn is pending", () => {
    expect(
      isWaitingUserMessage({
        messageID: "u2",
        delivery: "queue",
        pendingAssistantID: "a3",
        messages: openTurn,
      }),
    ).toBe(true)
    expect(pendingDeliveryBadge("queue")).toBe(" QUEUED ")
  })

  test("shows STEERING for newer steer follow-ups behind an open turn", () => {
    expect(
      isWaitingUserMessage({
        messageID: "u-steer",
        delivery: "steer",
        pendingAssistantID: "a3",
        messages: [...openTurn, { id: "u-steer", role: "user" }],
      }),
    ).toBe(true)
    expect(pendingDeliveryBadge("steer")).toBe(" STEERING ")
    expect(pendingDeliveryBadge(undefined)).toBe(" STEERING ")
  })

  test("hides badges for the active turn parent and once a queued turn starts", () => {
    expect(
      isWaitingUserMessage({
        messageID: "u1",
        pendingAssistantID: "a3",
        messages: openTurn,
      }),
    ).toBe(false)

    expect(
      isWaitingUserMessage({
        messageID: "u2",
        delivery: "queue",
        pendingAssistantID: "a4",
        messages: [...openTurn, { id: "a4", role: "assistant", parentID: "u2" }],
      }),
    ).toBe(false)
  })
})
