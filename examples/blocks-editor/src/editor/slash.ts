/**
 * A headless slash-command plugin. It detects a `/query` being typed at the
 * start of a textblock (or after whitespace) and publishes it to `slashKey`.
 * It renders nothing and handles no keys — the host's <SlashMenu /> owns the
 * popup, filtering and keyboard navigation.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { DastCommands } from "@agent-cms/editor-react";

/** One entry in the slash menu. `run` receives the DAST-vocabulary commands. */
export interface SlashCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly run: (commands: DastCommands) => boolean;
}

/** Live slash-command query state, read off the plugin key. */
export interface SlashQuery {
  readonly active: true;
  readonly query: string;
  /** Document range of the `/query` text to replace on commit/close. */
  readonly from: number;
  readonly to: number;
}

export const slashKey = new PluginKey<SlashQuery | null>("dast-slash-commands");

/** Detects `/query` before a cursor at the start of (or after whitespace in) a textblock. */
function detectSlash(state: EditorState): SlashQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  // Never trigger inside a code block.
  if ($from.parent.type.name === "code") return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(textBefore);
  if (!match) return null;
  const query = match[1] ?? "";
  // `from` points at the `/` itself: query chars, then the trigger, precede the cursor.
  return { active: true, query, from: $from.pos - query.length - 1, to: $from.pos };
}

/**
 * The extension. Pass to `useDastEditor` via its `extensions` option — the
 * array MUST be a stable reference (hoist it to module scope).
 */
export const SlashCommands = Extension.create({
  name: "dastSlashCommands",
  addProseMirrorPlugins() {
    return [
      new Plugin<SlashQuery | null>({
        key: slashKey,
        state: {
          init: () => null,
          apply(tr, value, _oldState, newState) {
            if (!tr.docChanged && !tr.selectionSet) return value;
            return detectSlash(newState);
          },
        },
      }),
    ];
  },
});
