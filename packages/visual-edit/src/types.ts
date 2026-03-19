/** Configuration for the visual edit client */
export interface CmsEditConfig {
  /** Base URL of the agent-cms REST API (e.g. "https://cms.example.com") */
  endpoint: string;
  /** Editor token or writeKey for authentication */
  token: string;
}

/** Identifies a specific field on a specific record */
export interface CmsFieldContext {
  recordId: string;
  modelApiKey: string;
  fieldApiKey: string;
  /** Locale code — omit for non-localized fields */
  locale?: string;
}

/** Supported editor types */
export type EditorType = "text" | "structured-text" | "image";
