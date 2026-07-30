/**
 * `blockView` is typed `ComponentType<BlockViewProps<Block>>`: the host cannot
 * pass it a single prop of its own. Anything a block card needs beyond
 * `{ id, block, inline, remove }` — "open this payload for editing", the
 * asset base URL, the current locale — has to arrive through React context.
 * See FRICTION.md #9.
 */
import { createContext, useContext } from "react";

export interface BlockEditing {
  readonly edit: (id: string) => void;
}

export const BlockEditingContext = createContext<BlockEditing>({ edit: () => undefined });

export const useBlockEditing = (): BlockEditing => useContext(BlockEditingContext);
