/** Warn only while a scene has changes that have not been acknowledged. */
export function bindUnsavedChangesGuard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  hasUnsavedChanges: () => boolean,
) {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  target.addEventListener('beforeunload', beforeUnload as EventListener);
  return () => target.removeEventListener('beforeunload', beforeUnload as EventListener);
}

export function whiteboardSaveStatus(connected: boolean, pending: boolean, failed: boolean): string {
  if (failed) return 'Changes not saved — check the error message';
  if (!connected) return pending ? 'Unsaved changes — reconnecting… Keep this tab open.' : 'Connecting…';
  return pending ? 'Saving changes…' : 'Changes synced';
}
