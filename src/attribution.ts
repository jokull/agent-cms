export interface RequestActor {
  readonly type: "admin" | "editor";
  readonly label: string;
  readonly tokenId?: string | null;
}

export interface VersionAttribution {
  readonly action: "publish" | "auto_republish" | "restore";
  readonly actor?: RequestActor | null;
}

export const ACTOR_TYPE_HEADER = "X-Cms-Actor-Type";
export const ACTOR_LABEL_HEADER = "X-Cms-Actor-Label";
export const ACTOR_TOKEN_ID_HEADER = "X-Cms-Actor-Token-Id";

export function actorLabel(actor?: RequestActor | null): string | null {
  return actor?.label ?? null;
}

export function actorHeaders(actor?: RequestActor | null): Record<string, string> {
  if (!actor) return {};
  const headers: Record<string, string> = {
    [ACTOR_TYPE_HEADER]: actor.type,
    [ACTOR_LABEL_HEADER]: actor.label,
  };
  if (actor.tokenId) {
    headers[ACTOR_TOKEN_ID_HEADER] = actor.tokenId;
  }
  return headers;
}

export function actorFromHeaders(headers: Headers): RequestActor | null {
  const type = headers.get(ACTOR_TYPE_HEADER);
  const label = headers.get(ACTOR_LABEL_HEADER);
  if ((type !== "admin" && type !== "editor") || !label) return null;
  return {
    type,
    label,
    tokenId: headers.get(ACTOR_TOKEN_ID_HEADER),
  };
}
