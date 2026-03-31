import { resolve } from "node:path";
import { openState } from "../core/import-state.mjs";
import { createAgentCmsClient } from "../core/agent-cms.mjs";

class ProgressTracker {
  constructor(total) {
    this.total = total;
    this.processed = 0;
    this.startTime = Date.now();
  }

  tick() {
    this.processed++;
  }

  format() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = elapsed > 0 ? this.processed / elapsed : 0;
    const remaining = this.total - this.processed;
    const etaSec = rate > 0 ? remaining / rate : 0;
    const pct = ((this.processed / this.total) * 100).toFixed(1);
    return `[${this.processed}/${this.total}] ${pct}% — ${rate.toFixed(1)}/sec — ETA: ${formatDuration(etaSec)}`;
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function mapWithConcurrency(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export async function runAssetImport({ cmsUrl, cmsWriteKey, project, concurrency = 6, dryRun = false, outDir }) {
  const resolvedOutDir = resolve(outDir);
  const state = openState(resolvedOutDir, project);

  try {
    const total = state.pendingAssetCount();

    if (dryRun) {
      const counts = state.assetCountsByStatus();
      console.log(`Asset queue summary for project: ${project}`);
      console.log(`  pending:  ${counts.pending ?? 0}`);
      console.log(`  imported: ${counts.imported ?? 0}`);
      console.log(`  skipped:  ${counts.skipped ?? 0}`);
      console.log(`  failed:   ${counts.failed ?? 0}`);
      console.log(`Dry run — no assets will be imported.`);
      return;
    }

    if (total === 0) {
      console.log("No pending assets. Nothing to do.");
      return;
    }

    console.log(`Starting asset import — ${total} pending assets`);

    const cms = createAgentCmsClient({ cmsUrl, cmsWriteKey });
    const runId = state.startRun("assets");
    const tracker = new ProgressTracker(total);
    const batchSize = concurrency * 2;

    let assetsImported = 0;
    let assetsSkipped = 0;
    let assetsFailed = 0;
    let lastProgressAt = 0;
    const progressInterval = 10;

    while (true) {
      const batch = state.pendingAssets(batchSize);
      if (batch.length === 0) break;

      await mapWithConcurrency(
        batch,
        async (asset) => {
          try {
            const existing = await cms.getAsset(asset.upload_id);
            if (existing.status === 200) {
              state.updateAssetStatus(asset.upload_id, "skipped");
              assetsSkipped++;
            } else {
              await cms.importAssetFromUrl({
                id: asset.upload_id,
                url: asset.source_url,
                filename: asset.filename,
                mimeType: asset.mime_type,
              });
              state.updateAssetStatus(asset.upload_id, "imported");
              assetsImported++;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            state.updateAssetStatus(asset.upload_id, "failed", message);
            assetsFailed++;
          }

          tracker.tick();

          if (tracker.processed - lastProgressAt >= progressInterval || tracker.processed === tracker.total) {
            lastProgressAt = tracker.processed;
            console.log(tracker.format());
            state.updateRunProgress(runId, {
              recordsImported: 0,
              recordsSkipped: 0,
              assetsImported,
              assetsSkipped,
            });
          }
        },
        concurrency,
      );
    }

    state.completeRun(runId);

    console.log(`\nAsset import complete`);
    console.log(`  imported: ${assetsImported}`);
    console.log(`  skipped:  ${assetsSkipped}`);
    console.log(`  failed:   ${assetsFailed}`);
  } finally {
    state.close();
  }
}
