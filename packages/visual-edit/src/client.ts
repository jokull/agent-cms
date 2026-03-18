import type { CmsEditConfig, CmsFieldContext } from "./types.js";

/** Thin REST client for agent-cms write operations. */
export class CmsClient {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config: CmsEditConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.writeKey}`,
    };
  }

  /** Update a single field on a record. */
  async patchField(ctx: CmsFieldContext, value: unknown): Promise<void> {
    const fieldData = ctx.locale
      ? { [ctx.fieldApiKey]: { [ctx.locale]: value } }
      : { [ctx.fieldApiKey]: value };

    const res = await fetch(`${this.endpoint}/api/records/${ctx.recordId}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify({
        modelApiKey: ctx.modelApiKey,
        data: fieldData,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS patch failed (${res.status}): ${body}`);
    }
  }

  /** Request a presigned upload URL from the CMS. Returns null if not configured (501). */
  private async requestUploadUrl(
    filename: string,
    mimeType: string,
  ): Promise<{ uploadUrl: string; r2Key: string; assetId: string } | null> {
    const res = await fetch(`${this.endpoint}/api/assets/upload-url`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ filename, mimeType }),
    });

    if (res.status === 501) return null;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS upload-url failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<{ uploadUrl: string; r2Key: string; assetId: string }>;
  }

  /** Upload file directly via R2 binding fallback (PUT binary body). */
  private async uploadFileDirect(assetId: string, file: File): Promise<{ r2Key: string }> {
    const res = await fetch(`${this.endpoint}/api/assets/${assetId}/file`, {
      method: "PUT",
      headers: {
        Authorization: this.headers.Authorization,
        "Content-Type": file.type,
        "X-Filename": file.name,
      },
      body: file,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS file upload failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<{ r2Key: string }>;
  }

  /** Update asset metadata in the CMS. */
  private async patchAsset(
    assetId: string,
    metadata: {
      filename: string;
      mimeType: string;
      size: number;
      r2Key: string;
      width?: number;
      height?: number;
    },
  ): Promise<void> {
    const res = await fetch(`${this.endpoint}/api/assets/${assetId}`, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(metadata),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS asset update failed (${res.status}): ${body}`);
    }
  }

  /** Publish a record. */
  async publishRecord(recordId: string, modelApiKey: string): Promise<void> {
    const res = await fetch(
      `${this.endpoint}/api/records/${recordId}/publish?modelApiKey=${encodeURIComponent(modelApiKey)}`,
      { method: "POST", headers: this.headers },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS publish failed (${res.status}): ${body}`);
    }
  }

  /** Replace an asset's file while keeping the same ID. */
  async replaceAsset(
    assetId: string,
    file: File,
    metadata?: { width?: number; height?: number; alt?: string },
  ): Promise<void> {
    // Try presigned upload first
    const grant = await this.requestUploadUrl(file.name, file.type);

    let r2Key: string;

    if (grant) {
      // Upload directly to R2 via presigned URL
      await fetch(grant.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      r2Key = grant.r2Key;
    } else {
      // Fallback: upload via Worker binary endpoint
      const result = await this.uploadFileDirect(assetId, file);
      r2Key = result.r2Key;
    }

    // Register/update asset metadata in CMS
    await this.patchAsset(assetId, {
      filename: file.name,
      mimeType: file.type,
      size: file.size,
      r2Key,
      ...metadata,
    });
  }
}
