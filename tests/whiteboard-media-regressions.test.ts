import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const hooks = vi.hoisted(() => {
  let cursor = 0;
  const refs: any[] = [];
  return {
    reset: () => { cursor = 0; refs.length = 0; },
    useRef: (value: any) => refs[cursor++] ??= { current: value },
    useCallback: (callback: any) => callback,
    // Exercise the real hydration callbacks without DOM/metadata lifecycle work.
    useEffect: () => {},
    useState: (initial: any) => [initial, () => {}],
  };
});
const assets = vi.hoisted(() => ({
  fetchBoardCanvasBytes: vi.fn(), fetchCanvasBytes: vi.fn(), uploadCanvasBytes: vi.fn(),
}));
vi.mock("react", async (original) => ({ ...await original<any>(), ...hooks }));
vi.mock("@excalidraw/excalidraw", () => ({ CaptureUpdateAction: { NEVER: "never" }, convertToExcalidrawElements: vi.fn() }));
vi.mock("../src/lib/whiteboard-identity", () => ({ getActiveIdentity: () => null, getAuthHeaders: async () => ({}), onAuthChange: () => () => {} }));
vi.mock("../src/lib/whiteboard-participants", () => ({ getBoardSessionAuth: () => null }));
vi.mock("../src/lib/whiteboard-assets", () => ({
  ...assets,
  assetResolveUrl: (owner: string, id: string) => `/assets/${owner}/${id}`,
  claimTempCanvasAssets: vi.fn(), fetchBoardAssetMeta: vi.fn(),
  ownerKeyForBoardMeta: (board: string) => `temp:${board}`,
  parsePlayerPath: () => null, playerPath: vi.fn(), registerTempAssetPrefix: vi.fn(),
  tempOwnerKey: (board: string) => `temp:${board}`,
}));

import { useWhiteboardExcalidrawFiles } from "../src/lib/whiteboard-excalidraw-files";

const BOARD = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const scene = [{ id: "image", type: "image", fileId: FILE, isDeleted: false }] as unknown as OrderedExcalidrawElement[];
const bytes = () => ({ blob: new Blob(["image"], { type: "image/png" }), mimeType: "image/png" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function editor() {
  const files: BinaryFiles = {};
  const api = {
    addFiles: vi.fn((added: BinaryFileData[]) => { for (const file of added) files[file.id] = file; }),
    getFiles: () => files,
    getSceneElementsIncludingDeleted: () => scene,
  };
  return { api: api as unknown as ExcalidrawImperativeAPI, addFiles: api.addFiles, files };
}
function mount() {
  const first = editor();
  const apiRef = { current: first.api };
  const hook = useWhiteboardExcalidrawFiles(BOARD, apiRef);
  return { first, apiRef, hook };
}

beforeEach(() => {
  hooks.reset();
  assets.fetchBoardCanvasBytes.mockResolvedValue(bytes());
  assets.fetchCanvasBytes.mockResolvedValue(null);
  vi.stubGlobal("FileReader", class {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL() {
      this.result = "data:image/png;base64,aW1hZ2U=";
      Promise.resolve().then(() => this.onload?.());
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("instance-scoped binary image hydration", () => {
  it("rehydrates ready images after an edit/view permission remount", async () => {
    const { first, apiRef, hook } = mount();
    hook.syncFiles(scene, first.files);
    await settle();
    expect(first.addFiles).toHaveBeenCalledTimes(1);
    hook.syncFiles(scene, first.files);
    expect(assets.fetchBoardCanvasBytes).toHaveBeenCalledTimes(1);
    const replacement = editor();
    apiRef.current = replacement.api;
    hook.syncFiles(scene, replacement.files);
    await settle();
    expect(replacement.addFiles).toHaveBeenCalledTimes(1);
    expect(replacement.files[FILE].dataURL).toBe("data:image/png;base64,aW1hZ2U=");
    expect(assets.fetchBoardCanvasBytes).toHaveBeenCalledTimes(2);
    hook.syncFiles(scene, replacement.files);
    expect(assets.fetchBoardCanvasBytes).toHaveBeenCalledTimes(2);
  });

  it("does not apply an old in-flight hydration to either instance or block the replacement", async () => {
    const stale = deferred<ReturnType<typeof bytes>>();
    assets.fetchBoardCanvasBytes.mockReturnValueOnce(stale.promise);
    const { first, apiRef, hook } = mount();
    hook.syncFiles(scene, first.files);
    const replacement = editor();
    apiRef.current = replacement.api;
    hook.syncFiles(scene, replacement.files);
    await settle();
    expect(replacement.addFiles).toHaveBeenCalledTimes(1);
    stale.resolve(bytes());
    await settle();
    expect(first.addFiles).not.toHaveBeenCalled();
    expect(replacement.addFiles).toHaveBeenCalledTimes(1);
    hook.syncFiles(scene, replacement.files);
    expect(assets.fetchBoardCanvasBytes).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale legacy hydration after its owner lookup completes", async () => {
    assets.fetchBoardCanvasBytes.mockResolvedValueOnce(null);
    const legacy = deferred<any>();
    assets.fetchCanvasBytes.mockReturnValueOnce(legacy.promise);
    const { first, apiRef, hook } = mount();
    hook.syncFiles(scene, first.files);
    await settle();
    expect(assets.fetchCanvasBytes).toHaveBeenCalledTimes(1);
    const replacement = editor();
    apiRef.current = replacement.api;
    legacy.resolve({ ...bytes(), ownerKey: `temp:${BOARD}` });
    await settle();
    expect(first.addFiles).not.toHaveBeenCalled();
    hook.syncFiles(scene, replacement.files);
    await settle();
    expect(replacement.addFiles).toHaveBeenCalledTimes(1);
  });

  it("does not carry an old instance's failed/retry throttle into its replacement", async () => {
    assets.fetchBoardCanvasBytes.mockResolvedValueOnce(null);
    const { first, apiRef, hook } = mount();
    hook.syncFiles(scene, first.files);
    await settle();
    expect(first.addFiles).not.toHaveBeenCalled();
    const replacement = editor();
    apiRef.current = replacement.api;
    hook.syncFiles(scene, replacement.files);
    await settle();
    expect(replacement.addFiles).toHaveBeenCalledTimes(1);
  });

  it("verifies readiness when resetScene clears binary files on the same API", async () => {
    const { first, hook } = mount();
    hook.syncFiles(scene, first.files);
    await settle();
    delete first.files[FILE];
    hook.syncFiles(scene, first.files);
    await settle();
    expect(first.addFiles).toHaveBeenCalledTimes(2);
    expect(first.files[FILE]).toBeDefined();
  });
});
