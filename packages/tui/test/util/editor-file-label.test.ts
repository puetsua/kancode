import path from "path"
import { expect, test } from "bun:test"
import { EDITOR_FILE_LABEL_NARROW_WIDTH, formatEditorFileLabel } from "../../src/util/editor-file-label"

test("wide terminals keep source prefix and index parent", () => {
  expect(
    formatEditorFileLabel({
      filePath: path.join("packages", "tui", "src", "component", "prompt", "index.tsx"),
      selectionLabel: "#12",
      sourceLabel: "Cursor",
      width: 120,
    }),
  ).toBe("Cursor · prompt/index.tsx#12")
})

test("narrow terminals show basename only without source", () => {
  expect(
    formatEditorFileLabel({
      filePath: path.join("packages", "tui", "src", "component", "prompt", "index.tsx"),
      selectionLabel: "#12",
      sourceLabel: "Cursor",
      width: EDITOR_FILE_LABEL_NARROW_WIDTH - 1,
    }),
  ).toBe("index.tsx#12")
})

test("narrow terminals still basename ordinary files", () => {
  expect(
    formatEditorFileLabel({
      filePath: path.join("packages", "tui", "src", "util", "locale.ts"),
      sourceLabel: "Zed",
      width: 60,
    }),
  ).toBe("locale.ts")
})

test("wide terminals without source keep basename truncation budget", () => {
  expect(
    formatEditorFileLabel({
      filePath: path.join("src", "very-long-file-name-that-needs-truncation.ts"),
      width: 36,
    }),
  ).toBe("very-l…on.ts")
})
