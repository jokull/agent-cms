import { createContext, useContext, useMemo } from "react";
import { CmsClient } from "@agent-cms/visual-edit";
import type { CmsEditConfig } from "@agent-cms/visual-edit";

interface CmsEditContextValue {
  client: CmsClient;
  enabled: boolean;
}

const CmsEditContext = createContext<CmsEditContextValue | null>(null);

export interface CmsEditProviderProps extends CmsEditConfig {
  /** Whether edit mode is active. Default: true */
  enabled?: boolean;
  children: React.ReactNode;
}

/**
 * Provides CMS edit configuration to all CmsText/CmsImage components below.
 *
 * ```tsx
 * <CmsEditProvider endpoint="https://cms.example.com" writeKey="..." enabled={isDraft}>
 *   <App />
 * </CmsEditProvider>
 * ```
 */
export function CmsEditProvider({ endpoint, writeKey, enabled = true, children }: CmsEditProviderProps) {
  const value = useMemo(
    () => ({ client: new CmsClient({ endpoint, writeKey }), enabled }),
    [endpoint, writeKey, enabled],
  );
  return <CmsEditContext value={value}>{children}</CmsEditContext>;
}

export function useCmsEdit(): CmsEditContextValue | null {
  return useContext(CmsEditContext);
}
