import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSceneElements, type SceneElement } from "../src/lib/whiteboard-sync";
import { persistedSceneChanged, retainMissingSceneElements } from "../src/lib/whiteboard-client-scene";
import { sessionTokenMatchesIdentity } from "../src/lib/whiteboard-client-auth";

const harness = vi.hoisted(() => {
  const slots: any[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  const cleanups: (() => void)[] = [];
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    slots, effects, cleanups,
    start: () => { cursor = 0; },
    reset: () => { slots.length = 0; effects.length = 0; cleanups.length = 0; cursor = 0; },
    useRef: (value: any) => slots[cursor++] ??= { current: value },
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: any) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useCallback: (callback: any, deps: any[]) => {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect: (callback: any, deps: any[]) => {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const old = slots[index];
        slots[index] = { deps };
        effects.push(() => {
          old?.cleanup?.();
          const cleanup = callback();
          slots[index].cleanup = cleanup;
          if (cleanup) cleanups.push(cleanup);
        });
      }
    },
  };
});
const auth = vi.hoisted(() => ({
  identity: null as any,
  listener: null as any,
  fresh: vi.fn(), settled: vi.fn(), cached: "",
}));
const role = vi.hoisted(() => ({
  canEdit: false, role: "viewer", helloReceived: false,
  viewModeEnabled: true, displayName: "Guest", forceFollowLocked: false,
  handleSocketMessage: vi.fn(), onUserFollow: vi.fn(), reassertFollow: vi.fn(),
  resubscribeFollow: vi.fn(), onScrollChange: vi.fn(),
}));
const preview = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<any>(), ...harness }));
vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => null,
  CaptureUpdateAction: { NEVER: "never" },
  getSceneVersion: (elements: any[]) => elements.reduce((sum, el) => sum + el.version, 0),
  newElementWith: (element: any, patch: any) => ({ ...element, ...patch, version: element.version + 1, versionNonce: 17 }),
  restoreElements: (elements: any[]) => elements,
  reconcileElements: (local: any[], remote: any[]) => {
    const map = new Map(local.map((el) => [el.id, el]));
    for (const el of remote) {
      const previous = map.get(el.id);
      if (!previous || el.version > previous.version ||
        (el.version === previous.version && el.versionNonce <= previous.versionNonce)) map.set(el.id, el);
    }
    return [...map.values()];
  },
  serializeAsJSON: (elements: any[], appState: any) => JSON.stringify({ type: "excalidraw", elements, appState }),
}));
vi.mock("../src/lib/whiteboard-identity", () => ({
  getActiveIdentity: () => auth.identity,
  isSignedIn: () => Boolean(auth.identity),
  onAuthChange: (listener: any) => { auth.listener = listener; return () => { auth.listener = null; }; },
  getSessionTokenFresh: auth.fresh, getSessionTokenSettled: auth.settled,
  peekSessionToken: () => auth.cached, whenAuthReady: () => Promise.resolve(),
}));
vi.mock("../src/scripts/whiteboard-library", () => ({ getHostSecret: () => null }));
vi.mock("../src/lib/whiteboard-excalidraw-files", () => ({
  useWhiteboardExcalidrawFiles: () => ({ syncFiles: vi.fn(), validateEmbeddable: vi.fn(), renderEmbeddable: vi.fn(), onPaste: vi.fn() }),
}));
vi.mock("../src/lib/whiteboard-excalidraw-roles", () => ({
  FOLLOW_SOCKET_GAP_MS: 30_000,
  getBoardConnectIdentity: () => ({ displayName: "Guest", userId: "" }),
  useWhiteboardExcalidrawRoles: () => role,
}));
vi.mock("../src/lib/whiteboard-preview", () => ({
  bindPreviewLifecycle: () => () => {},
  createPreviewCoordinator: () => ({ invalidate: preview.invalidate, persist: vi.fn(), dispose: vi.fn(), scheduleCapture: vi.fn() }),
  exportBoardPreview: vi.fn(), uploadBoardPreview: vi.fn(),
}));
vi.mock("../src/lib/whiteboard-save-status", () => ({
  bindUnsavedChangesGuard: () => () => {}, whiteboardSaveStatus: () => "",
}));

import WhiteboardCanvas from "../src/components/WhiteboardCanvas";

const BOARD = "11111111-1111-4111-8111-111111111111";
const element = (id: string, version = 1): SceneElement => ({ id, version, versionNonce: 20, isDeleted: false, type: "rectangle" });
const identity = (id: string, displayName = id) => ({ clerkUserId: id, accountId: id, ownerKey: `google:${id}`, displayName });
const jwt = (sub: string, label = "token") => `header.${btoa(JSON.stringify({ sub, label }))}.signature`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  constructor(public url: string) { super(); Socket.instances.push(this); }
  send(json: string) { this.sent.push(JSON.parse(json)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: any) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) })); }
  close() { this.readyState = 3; /* Deliberately defer close callbacks. */ }
  closed() { this.dispatchEvent(new Event("close")); }
  frames(type: string) { return this.sent.filter((frame) => frame.type === type); }
}
let props: any;
function render() {
  harness.start();
  const tree: any = WhiteboardCanvas({ boardId: BOARD });
  props = tree.props.children[0].props;
  for (const effect of harness.effects.splice(0)) effect();
}
function editor(elements: SceneElement[] = []) {
  let scene = elements;
  let appState: any = { viewBackgroundColor: "#ffffff", scrollX: 0, selectedElementIds: {} };
  const api = {
    getSceneElementsIncludingDeleted: () => scene,
    getAppState: () => appState,
    onUserFollow: () => () => {},
    setToast: vi.fn(),
    updateScene: vi.fn((update: any) => {
      if (update.elements) scene = update.elements;
      if (update.appState) appState = { ...appState, ...update.appState };
      props.onChange(scene, appState, {});
    }),
    change(next: SceneElement[], patch: any = {}) {
      scene = next;
      appState = { ...appState, ...patch };
      props.onChange(scene, appState, {});
    },
  };
  return api;
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
async function setup(elements: SceneElement[] = [], canEdit = true) {
  render();
  const api = editor();
  props.excalidrawAPI(api);
  const ws = Socket.instances[0];
  ws.open();
  await settle();
  ws.message({ type: "wb:hello", role: canEdit ? "owner" : "viewer", canEdit });
  render();
  ws.message({ type: "scene:sync", elements, appState: { viewBackgroundColor: "#ffffff" }, revision: 1 });
  await settle();
  return { api, ws };
}
function changeIdentity(next: any) { auth.identity = next; auth.listener(next); }
function ack(ws: Socket, frame: any, revision = 2) { ws.message({ type: "scene:ack", mutationId: frame.mutationId, status: "applied", revision }); }

beforeEach(() => {
  vi.useFakeTimers();
  harness.reset();
  Socket.instances = [];
  auth.identity = null; auth.cached = ""; auth.listener = null;
  auth.fresh.mockResolvedValue(null); auth.settled.mockResolvedValue(null);
  role.canEdit = false; role.role = "viewer"; role.helloReceived = false; role.viewModeEnabled = true;
  role.handleSocketMessage.mockImplementation((data: any) => {
    if (data.type !== "wb:hello" && data.type !== "wb:role") return false;
    role.role = data.role; role.canEdit = data.canEdit; role.viewModeEnabled = !data.canEdit;
    if (data.type === "wb:hello") role.helloReceived = true;
    return true;
  });
  const win = Object.assign(new EventTarget(), {
    location: { origin: "https://example.test", pathname: `/board/${BOARD}` },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const doc = Object.assign(new EventTarget(), {
    documentElement: { getAttribute: () => "light" }, visibilityState: "visible",
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("window", win); vi.stubGlobal("document", doc);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => fn());
});
afterEach(async () => {
  for (const cleanup of harness.cleanups.splice(0)) cleanup();
  await settle();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("persisted canvas state and native Open", () => {
  it.each([{ scene: [] }, { scene: [element("shape")] }])("sends background-only edits, including empty boards (%j)", async ({ scene }) => {
    const { api, ws } = await setup(scene);
    api.change(scene, { viewBackgroundColor: "#123456" });
    await vi.advanceTimersByTimeAsync(1000);
    const frame = ws.frames("scene:update")[0];
    expect(frame).toBeDefined();
    expect(JSON.parse(frame.databaseJson).appState.viewBackgroundColor).toBe("#123456");
    ack(ws, frame);
    await settle();
    api.change(scene, { scrollX: 70, selectedElementIds: { shape: true }, theme: "dark" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(1);
  });

  it("periodic flush can send appstate-only changes even without an element/onChange dirty signal", async () => {
    const { api, ws } = await setup();
    api.getAppState().viewBackgroundColor = "#fedcba";
    await vi.advanceTimersByTimeAsync(30_000);
    const frame = ws.frames("scene:update")[0];
    expect(frame.elements).toEqual([]);
    expect(JSON.parse(frame.databaseJson).appState.viewBackgroundColor).toBe("#fedcba");
    ack(ws, frame);
    await settle();
    api.change([], { scrollX: 4, theme: "dark" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(1);
  });

  it("retires only the acked background while a newer background stays queued", async () => {
    const { api, ws } = await setup();
    api.change([], { viewBackgroundColor: "#111111" });
    await vi.advanceTimersByTimeAsync(1000);
    const first = ws.frames("scene:update")[0];
    api.change([], { viewBackgroundColor: "#222222" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("scene:update")).toHaveLength(1);
    ack(ws, { mutationId: crypto.randomUUID() });
    expect(ws.frames("scene:update")).toHaveLength(1);
    ack(ws, first);
    await settle();
    const second = ws.frames("scene:update")[1];
    expect(second.baseRevision).toBe(2);
    expect(JSON.parse(second.databaseJson).appState.viewBackgroundColor).toBe("#222222");
    ack(ws, second, 3);
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(2);
  });

  it.each([2, 4])("does not let an older flight ack (revision %i) replace a newer remote background baseline", async (revision) => {
    const { api, ws } = await setup();
    api.change([], { viewBackgroundColor: "#111111" });
    await vi.advanceTimersByTimeAsync(1000);
    const frame = ws.frames("scene:update")[0];
    ws.message({ type: "scene:update", elements: [], appState: { viewBackgroundColor: "#333333" }, revision: 3 });
    await settle();
    ack(ws, frame, revision);
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(1);
  });

  it("does not rebase queued backgrounds through an intervening peer revision", async () => {
    const { api, ws } = await setup();
    api.change([], { viewBackgroundColor: "#111111" });
    await vi.advanceTimersByTimeAsync(1000);
    const first = ws.frames("scene:update")[0];
    api.change([], { viewBackgroundColor: "#222222" });
    ws.message({ type: "scene:update", elements: [], appState: { viewBackgroundColor: "#333333" }, revision: 3 });
    await settle();
    ack(ws, first, 4);
    await settle();
    const second = ws.frames("scene:update")[1];
    expect(second.baseRevision).toBe(1);
    ws.message({ type: "scene:ack", mutationId: second.mutationId, status: "noop", revision: 4 });
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(2);
  });

  it("refreshes authoritative state when elements applied but a stale background did not", async () => {
    const { api, ws } = await setup([element("shape")]);
    api.change([element("shape", 2)], { viewBackgroundColor: "#111111" });
    await vi.advanceTimersByTimeAsync(1000);
    const frame = ws.frames("scene:update")[0];
    ws.message({ type: "scene:update", elements: [], revision: 2 });
    await settle();
    const requests = ws.frames("scene:request").length;
    ack(ws, frame, 3);
    await settle();
    expect(ws.frames("scene:request")).toHaveLength(requests + 1);
    ws.message({ type: "scene:sync", elements: [element("shape", 2)], appState: { viewBackgroundColor: "#ffffff" }, revision: 3 });
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(1);
  });

  it("invalidates cached previews for a background-only change, not local camera changes", async () => {
    const { api } = await setup([element("shape")]);
    preview.invalidate.mockClear();
    api.change(api.getSceneElementsIncludingDeleted(), { scrollX: 10 });
    expect(preview.invalidate).not.toHaveBeenCalled();
    api.change(api.getSceneElementsIncludingDeleted(), { viewBackgroundColor: "#123456" });
    expect(preview.invalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps retained tombstones mutable for Excalidraw fractional-index repair", () => {
    const deleted: SceneElement = Object.freeze({ ...element("deleted", 4), index: "a0", isDeleted: true });
    const imported = { ...element("imported"), index: "a0" };
    const next = retainMissingSceneElements([deleted], [imported], () => { throw new Error("must not bump"); });
    const retained = next.find((el) => el.id === deleted.id)!;
    expect(Object.isFrozen(retained)).toBe(false);
    retained.index = "a1";
    expect(deleted.index).toBe("a0");
    expect(retained.version).toBe(4);
  });

  it("restores omitted tombstones even if native Open leaves the durable scene unchanged", async () => {
    const deleted = { ...element("old", 4), isDeleted: true };
    const { api, ws } = await setup([deleted]);
    api.change([]);
    expect(api.getSceneElementsIncludingDeleted()).toEqual([deleted]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(0);
  });

  it("does not echo remote backgrounds or queue camera/theme/selection changes", async () => {
    const { api, ws } = await setup([element("remote")]);
    ws.message({ type: "scene:update", elements: [], appState: { viewBackgroundColor: "#abcdef" }, revision: 2 });
    await settle();
    api.change(api.getSceneElementsIncludingDeleted(), { scrollX: 5, theme: "dark", selectedElementIds: { remote: true } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.frames("scene:update")).toHaveLength(0);
  });

  it.each([{ imported: [] }, { imported: [element("imported")] }])("turns native Open omissions into deletions (%j)", async ({ imported }) => {
    const old = element("old", 3);
    const { api, ws } = await setup([old]);
    api.change(imported);
    await vi.advanceTimersByTimeAsync(1000);
    const frame = ws.frames("scene:update")[0];
    const tombstone = frame.elements.find((el: SceneElement) => el.id === "old");
    expect(tombstone).toMatchObject({ isDeleted: true, version: 4 });
    expect(api.getSceneElementsIncludingDeleted()).toContainEqual(tombstone);
    expect(mergeSceneElements([old], frame.elements).next.filter((el) => !el.isDeleted)).toEqual(imported);
    ack(ws, frame);
    await settle();
    // A remote full sync still merges; it is not treated as native replacement.
    ws.message({ type: "scene:sync", elements: [tombstone, element("peer")], appState: { viewBackgroundColor: "#ffffff" }, revision: 3 });
    await settle();
    expect(api.getSceneElementsIncludingDeleted()).toContainEqual(element("peer"));
    expect(api.getSceneElementsIncludingDeleted().find((el) => el.id === "old")?.isDeleted).toBe(true);
    if (imported.length) expect(api.getSceneElementsIncludingDeleted()).toContainEqual(imported[0]);
    // Undo/restore remains a higher-version local edit, not a permanent removal.
    api.change([...api.getSceneElementsIncludingDeleted().filter((el) => el.id !== "old"), { ...old, version: 5 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("scene:update")[1].elements.find((el: SceneElement) => el.id === "old")).toMatchObject({ isDeleted: false, version: 5 });
  });

  it("retains existing tombstones without bumping them and detects equal version-sum replacements", () => {
    const deleted = { ...element("deleted", 4), isDeleted: true };
    expect(retainMissingSceneElements([deleted], [], () => { throw new Error("must not bump"); })).toEqual([deleted]);
    expect(persistedSceneChanged([element("a")], [element("b")], "#fff", "#fff")).toBe(true);
  });
});

describe("socket authentication transitions", () => {
  it("upgrades a greeted guest with bounded retries when the token arrives later", async () => {
    const { ws } = await setup([], false);
    changeIdentity(identity("owner"));
    await settle();
    expect(Socket.instances).toHaveLength(1);
    expect(ws.frames("wb:auth").at(-1)).toMatchObject({ signedIn: true });
    // An unrelated permission change before token readiness is not an auth ack.
    ws.message({ type: "wb:role", role: "viewer", canEdit: false });
    auth.fresh.mockResolvedValue(jwt("owner"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("wb:auth").at(-1)).toMatchObject({ signedIn: true, token: jwt("owner") });
    ws.message({ type: "wb:role", role: "owner", canEdit: true });
    ws.message({ type: "wb:participants", yourSessionId: "self", participants: [{ sessionId: "self", userId: "owner", role: "owner" }] });
    const count = ws.frames("wb:auth").length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(ws.frames("wb:auth")).toHaveLength(count);
  });

  it("preserves a pending guest upgrade through a same-account profile change", async () => {
    const { ws } = await setup([], false);
    changeIdentity(identity("owner"));
    await settle();
    changeIdentity({ ...identity("owner", "Renamed"), profileUpdatedAt: 42 });
    await settle();
    auth.fresh.mockResolvedValue(jwt("owner"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("wb:auth").at(-1).token).toBe(jwt("owner"));
  });

  it("does not mistake an unrelated role update after sending a token for identity confirmation", async () => {
    const { ws } = await setup([], false);
    ws.message({ type: "wb:role", role: "editor", canEdit: false });
    auth.fresh.mockResolvedValue(jwt("owner", "unverified"));
    changeIdentity(identity("owner"));
    await settle();
    ws.message({ type: "wb:role", role: "editor", canEdit: true });
    auth.fresh.mockResolvedValue(jwt("owner", "refreshed"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("wb:auth").at(-1).token).toBe(jwt("owner", "refreshed"));
    ws.message({ type: "wb:participants", yourSessionId: "self", participants: [{ sessionId: "self", userId: "owner", role: "owner" }] });
    const calls = auth.fresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(auth.fresh).toHaveBeenCalledTimes(calls);
  });

  it("gives up retrying a greeted guest instead of polling indefinitely", async () => {
    const { ws } = await setup([], false);
    changeIdentity(identity("owner"));
    await settle();
    await vi.advanceTimersByTimeAsync(80_000);
    const calls = auth.fresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(auth.fresh).toHaveBeenCalledTimes(calls);
    expect(ws.frames("scene:update")).toHaveLength(0);
  });

  it.each([null, identity("other")])("replaces old-account context and ignores stale tokens/close/messages (%j)", async (next) => {
    auth.identity = identity("old");
    auth.settled.mockResolvedValue(jwt("old"));
    const { api, ws: oldSocket } = await setup([element("saved")]);
    api.change([element("saved"), element("unsaved")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(oldSocket.frames("scene:update")).toHaveLength(1);
    api.change([element("saved"), element("unsaved", 2)], { viewBackgroundColor: "#123456" });
    const pendingToken = deferred<string>();
    auth.fresh.mockReturnValueOnce(pendingToken.promise);
    changeIdentity(identity("old", "Renamed"));
    changeIdentity(next);
    render();
    expect(role.canEdit).toBe(false);
    expect(props.viewModeEnabled).toBe(true);
    const freshSocket = Socket.instances[1];
    expect(freshSocket.url).not.toEqual(oldSocket.url);
    auth.fresh.mockResolvedValue(next ? jwt("other") : null);
    freshSocket.open();
    oldSocket.closed();
    oldSocket.message({ type: "wb:role", role: "owner", canEdit: true });
    pendingToken.resolve(jwt("old", "stale"));
    await settle();
    expect(freshSocket.frames("wb:auth").some((frame) => frame.token === jwt("old", "stale") || frame.token === jwt("old"))).toBe(false);
    expect(role.canEdit).toBe(false);
    freshSocket.message({ type: "wb:hello", role: "viewer", canEdit: false });
    render();
    freshSocket.message({ type: "scene:sync", elements: [element("saved")], appState: { viewBackgroundColor: "#ffffff" }, revision: 2 });
    await settle();
    expect(api.getSceneElementsIncludingDeleted()).toEqual([element("saved")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(Socket.instances).toHaveLength(2);
    expect(freshSocket.frames("scene:update")).toHaveLength(0);
  });

  it("guards guest-upgrade tokens across a subsequent identity/socket change", async () => {
    const { ws } = await setup([], false);
    const token = deferred<string>();
    auth.fresh.mockReturnValueOnce(token.promise);
    changeIdentity(identity("first"));
    changeIdentity(identity("second"));
    const nextSocket = Socket.instances[1];
    nextSocket.open();
    token.resolve(jwt("first"));
    await settle();
    expect(ws.frames("wb:auth").some((frame) => frame.token === jwt("first"))).toBe(false);
    expect(nextSocket.frames("wb:auth").some((frame) => frame.token === jwt("first"))).toBe(false);
  });

  it("rejects stale cached/fallback JWTs even when the token fetch started under the new account", async () => {
    auth.identity = identity("old");
    auth.cached = jwt("old");
    auth.settled.mockResolvedValue(jwt("old"));
    await setup();
    auth.fresh.mockResolvedValue(jwt("old", "late-fallback"));
    changeIdentity(identity("new"));
    const ws = Socket.instances[1];
    ws.open();
    await settle();
    expect(ws.frames("wb:auth").every((frame) => !frame.token)).toBe(true);
    auth.fresh.mockResolvedValue(jwt("new"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("wb:auth").at(-1).token).toBe(jwt("new"));
    expect(sessionTokenMatchesIdentity(jwt("old"), "new")).toBe(false);
    expect(sessionTokenMatchesIdentity("malformed", "new")).toBe(false);
  });

  it("stops same-role guest identity refresh retries on the authenticated participant broadcast", async () => {
    const { ws } = await setup([], false);
    auth.fresh.mockResolvedValue(jwt("viewer"));
    changeIdentity(identity("viewer"));
    await settle();
    ws.message({ type: "wb:participants", yourSessionId: "self", participants: [{ sessionId: "self", userId: "viewer", role: "viewer" }] });
    const calls = auth.fresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(auth.fresh).toHaveBeenCalledTimes(calls);
  });

  it("sends cached auth immediately and retries early signed-in auth until hello", async () => {
    auth.identity = identity("owner");
    auth.cached = jwt("owner", "cached");
    auth.settled.mockResolvedValue(null);
    auth.fresh.mockResolvedValue(jwt("owner", "fresh"));
    render();
    const ws = Socket.instances[0];
    ws.open();
    expect(ws.frames("wb:auth")[0]).toMatchObject({ token: jwt("owner", "cached"), signedIn: true });
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.frames("wb:auth").at(-1).token).toBe(jwt("owner", "fresh"));
    ws.message({ type: "wb:hello", role: "owner", canEdit: true });
    const calls = auth.fresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(auth.fresh).toHaveBeenCalledTimes(calls);
  });

  it("preserves profile refresh without replacing a same-account socket", async () => {
    auth.identity = identity("owner");
    auth.settled.mockResolvedValue(jwt("owner"));
    const { ws } = await setup();
    auth.fresh.mockResolvedValue(jwt("owner", "fresh"));
    changeIdentity({ ...identity("owner", "Renamed"), profileUpdatedAt: 42 });
    await settle();
    expect(Socket.instances).toHaveLength(1);
    expect(ws.frames("wb:auth").at(-1)).toMatchObject({ token: jwt("owner", "fresh"), refreshProfile: true, profileUpdatedAt: 42 });
  });
});
