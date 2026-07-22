import path from "path"
import { truncateMiddle } from "./locale"

/** Matches permission footer / run footer compact breakpoint. */
export const EDITOR_FILE_LABEL_NARROW_WIDTH = 80

export function formatEditorFileLabel(input: {
  filePath: string
  selectionLabel?: string
  sourceLabel?: string
  width: number
}) {
  const filename = path.basename(input.filePath)
  const narrow = input.width < EDITOR_FILE_LABEL_NARROW_WIDTH
  const file =
    !narrow && /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(input.filePath)), filename].filter(Boolean).join("/")
      : filename
  const labeled = `${file.split(path.sep).join("/")}${input.selectionLabel ?? ""}`
  const max = Math.max(12, Math.min(48, Math.floor(input.width / 3)))

  // Narrow terminals: filename only (no editor source prefix).
  if (narrow || !input.sourceLabel) return truncateMiddle(labeled, max)

  const budget = Math.max(8, max - input.sourceLabel.length - 3)
  return `${input.sourceLabel} · ${truncateMiddle(labeled, budget)}`
}
