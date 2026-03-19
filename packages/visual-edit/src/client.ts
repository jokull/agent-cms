import type { CmsEditConfig, CmsFieldContext } from "./types.js";

export interface Asset {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  title: string | null;
  created_at: string;
}

export interface AssetListResponse {
  assets: Asset[];
  total: number;
}

/** Thin REST client for agent-cms write operations. */
export class CmsClient {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config: CmsEditConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    };
  }

  /** Public getter so overlay can construct thumbnail URLs. */
  getEndpoint(): string {
    return this.endpoint;
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

  /** List/search assets with pagination. */
  async listAssets(opts?: { query?: string; page?: number; perPage?: number }): Promise<AssetListResponse> {
    const perPage = opts?.perPage ?? 24;
    const page = opts?.page ?? 1;
    const offset = (page - 1) * perPage;
    const params = new URLSearchParams();
    if (opts?.query) params.set("q", opts.query);
    params.set("limit", String(perPage));
    params.set("offset", String(offset));

    const res = await fetch(`${this.endpoint}/api/assets?${params}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS list assets failed (${res.status}): ${body}`);
    }

    return res.json() as Promise<AssetListResponse>;
  }

  /** Update only alt/title metadata on an asset. */
  async updateAssetMetadata(assetId: string, metadata: { alt?: string; title?: string }): Promise<void> {
    const res = await fetch(`${this.endpoint}/api/assets/${assetId}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(metadata),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS asset metadata update failed (${res.status}): ${body}`);
    }
  }

  /** Upload a new file and register it as an asset. Returns the new asset. */
  async createAsset(file: File, metadata?: { alt?: string }): Promise<Asset> {
    // Get presigned URL or fallback
    const grant = await this.requestUploadUrl(file.name, file.type);
    let r2Key: string;
    let assetId: string;

    if (grant) {
      const uploadRes = await fetch(grant.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!uploadRes.ok) {
        throw new Error(`Asset upload failed (${uploadRes.status})`);
      }
      r2Key = grant.r2Key;
      assetId = grant.assetId;
    } else {
      assetId = crypto.randomUUID();
      const result = await this.uploadFileDirect(assetId, file);
      r2Key = result.r2Key;
    }

    // Read dimensions
    const dims = await this.readImageDimensions(file);

    // Register asset in CMS
    const res = await fetch(`${this.endpoint}/api/assets`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        id: assetId,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        r2Key,
        width: dims?.width,
        height: dims?.height,
        alt: metadata?.alt,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CMS create asset failed (${res.status}): ${body}`);
    }

    const result = await res.json() as { id: string; filename: string; mimeType: string; size: number; width?: number; height?: number; alt?: string; title?: string; createdAt: string };
    return {
      id: result.id,
      filename: result.filename,
      mime_type: result.mimeType,
      size: result.size,
      width: result.width ?? null,
      height: result.height ?? null,
      alt: result.alt ?? null,
      title: result.title ?? null,
      created_at: result.createdAt,
    };
  }

  /** Read image dimensions from a File. Returns null for non-image files. */
  private readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
    if (!file.type.startsWith("image/")) return Promise.resolve(null);
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
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
      const uploadRes = await fetch(grant.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!uploadRes.ok) {
        throw new Error(`Asset upload failed (${uploadRes.status})`);
      }
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
