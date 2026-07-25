/**
 * Consumer half of the `<conversation_context>` envelope.
 *
 * The host produces the envelope (`session/cruise-control-prompt.ts`) and this
 * module parses it. That makes the envelope a wire contract between host and
 * plugin, not an internal detail — see the "Host-Provided Classifier Context"
 * requirement in `openspec/specs/permission-modules/spec.md`. The regexes are
 * deliberately duplicated rather than imported: once this plugin ships
 * separately it cannot reach host internals, and a silent divergence here
 * degrades to "no explicit approval detected", which fails safe.
 */

const SHORT_AFFIRMATION =
  /^(?:ok(?:ay)?|yes|yep|yeah|yup|sure|go ahead|proceed|do it|please do|approved?|affirmative|sounds good|that works|go for it|👍|✅)(?:[.!]?)$/i

const CONVERSATION_CONTEXT =
  /<conversation_context>\s*<prior_assistant_reply>\s*([\s\S]*?)\s*<\/prior_assistant_reply>\s*<current_user_reply>\s*([\s\S]*?)\s*<\/current_user_reply>\s*<\/conversation_context>/i

export function isShortAffirmation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 40) return false
  return SHORT_AFFIRMATION.test(trimmed)
}

/** True when the assistant's reply names the action actually being gated. */
function pendingActionMentioned(
  assistantReply: string,
  patterns: readonly string[],
  metadata?: Record<string, unknown>,
): boolean {
  const haystack = assistantReply.toLowerCase()
  for (const pattern of patterns) {
    const normalized = pattern.trim().toLowerCase()
    if (normalized && normalized !== "*" && haystack.includes(normalized)) return true
  }
  const command = metadata?.command
  if (typeof command === "string") {
    const normalized = command.trim().toLowerCase()
    if (normalized && haystack.includes(normalized)) return true
  }
  return false
}

/**
 * True when the user gave a short approval that clearly responds to the assistant's
 * permission ask for the pending action described in patterns/metadata.
 * Reads the host-only enriched prompt; never classifier-visible session data.
 */
export function explicitApprovalIntent(
  userPrompt: string | undefined,
  patterns: readonly string[],
  metadata?: Record<string, unknown>,
): boolean {
  if (!userPrompt) return false
  const match = userPrompt.match(CONVERSATION_CONTEXT)
  if (!match) return false
  const assistantReply = match[1]?.trim() ?? ""
  const userReply = match[2]?.trim() ?? ""
  if (!assistantReply || !isShortAffirmation(userReply)) return false
  return pendingActionMentioned(assistantReply, patterns, metadata)
}
