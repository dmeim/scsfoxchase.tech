# Reliable Whiteboard Asset Uploads

- [x] Add board-scoped R2 asset routes and a Durable Object asset manifest while preserving legacy asset reads.
- [x] Enforce upload-before-scene persistence/broadcast and add persisted scene acknowledgements.
- [x] Add a durable IndexedDB upload outbox with retries, reconnect/reload recovery, pending-element filtering, and deletion handling.
- [x] Add per-asset inline upload overlays and a global upload status/retry control without blocking normal drawing.
- [ ] Add backend and UI integration coverage for upload failure/retry/reload, authorization, manifest ordering, and responsive upload UI. Current automated coverage is limited to the IndexedDB outbox unit/state-machine tests.
- [x] Update whiteboard storage/auth documentation for the new board-scoped lifecycle and compatibility behavior.
- [x] Run adversarial correctness/security review, repair findings, and verify the production build and tests.

## Fixed decisions

- R2 remains the binary store; image/video bytes are not embedded in scene JSON or Durable Object rows.
- New keys use `boards/{boardId}/assets/{fileId}`; existing `assets/{ownerKey}/{fileId}` reads remain compatible.
- A new image element cannot be persisted or broadcast until its R2 upload and manifest registration complete.
- Pending uploads are first staged in IndexedDB and resume after reload/reconnect.
- Upload UI is an unpersisted DOM overlay: immediate dimming, an indeterminate centered loader after 250 ms, compact spinner for tiny icons, and a persistent failure state with retry/remove controls.
- No modal is shown during normal uploads; warn only when the local outbox itself cannot be written.
- The client clears its outbox entry only after the server acknowledges persistence of the corresponding scene element.
- Backend-compatible changes deploy before the client switches to the new flow.
