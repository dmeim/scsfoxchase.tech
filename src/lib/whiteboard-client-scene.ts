import type { SceneElement } from "./whiteboard-sync";

/** Native Open/reset omits old elements; collaboration needs explicit deletions. */
export function retainMissingSceneElements<T extends SceneElement>(
  previous: readonly T[],
  current: readonly T[],
  deleteElement: (element: T) => T,
): readonly T[] {
  const ids = new Set(current.map((element) => element.id));
  const missing = previous.filter((element) => !ids.has(element.id));
  if (missing.length === 0) return current;
  return [
    ...current,
    ...missing.map((element) => element.isDeleted ? { ...element } : deleteElement(element)),
  ];
}

export function persistedSceneChanged(
  previous: readonly SceneElement[],
  current: readonly SceneElement[],
  previousBackground: string | null,
  currentBackground: string,
): boolean {
  if (previousBackground !== currentBackground || previous.length !== current.length) {
    return true;
  }
  const byId = new Map(previous.map((element) => [element.id, element]));
  return current.some((element) => {
    const old = byId.get(element.id);
    return !old || old.version !== element.version ||
      old.versionNonce !== element.versionNonce || old.isDeleted !== element.isDeleted;
  });
}
