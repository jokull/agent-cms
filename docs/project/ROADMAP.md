# Roadmap

## Asset ingestion

- Signed upload handoff for editor agents
  - Goal: keep binary upload out of the Worker request path while avoiding direct R2 credentials for agents/editors.
  - Shape: an authenticated REST endpoint can mint a short-lived signed upload target when called with the write key.
  - Flow:
    1. Agent calls the CMS REST API with the write key to request an upload grant
    2. Client uploads the original binary directly to R2 using that grant
    3. Agent registers the asset metadata in agent-cms with the resulting `r2Key`
  - Why: preserves the direct-to-R2 architecture while improving developer/editor experience.
