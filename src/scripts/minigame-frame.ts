type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenFrame = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function initMinigameFrame(frame: HTMLElement): void {
  const button = frame.querySelector<HTMLButtonElement>("[data-minigame-fullscreen]");
  const label = button?.querySelector<HTMLElement>("[data-fullscreen-label]");
  const feedback = frame.querySelector<HTMLElement>("[data-minigame-feedback]");
  if (!button || !label || !feedback) throw new Error("The mini-game fullscreen controls are missing.");
  const fullscreenButton = button;
  const fullscreenLabel = label;
  const fullscreenFeedback = feedback;
  const doc = document as FullscreenDocument;
  const player = frame as FullscreenFrame;
  const controller = new AbortController();
  const active = () => (doc.fullscreenElement ?? doc.webkitFullscreenElement) === frame;
  const supported = Boolean(
    (doc.fullscreenEnabled && player.requestFullscreen) ||
    (doc.webkitFullscreenEnabled && player.webkitRequestFullscreen)
  );

  function sync(): void {
    const isActive = active();
    const text = isActive ? "Exit fullscreen" : "Fullscreen";
    fullscreenLabel.textContent = text;
    fullscreenButton.setAttribute("aria-label", isActive ? text : "Enter fullscreen");
    fullscreenButton.setAttribute("aria-pressed", String(isActive));
    frame.dataset.fullscreen = String(isActive);
    frame.dispatchEvent(new CustomEvent("minigame:fullscreenchange", { detail: { active: isActive } }));
  }

  fullscreenButton.hidden = !supported;
  fullscreenButton.addEventListener("click", async () => {
    fullscreenFeedback.hidden = true;
    try {
      if (active()) {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else await doc.webkitExitFullscreen?.();
      } else if (player.requestFullscreen) {
        await player.requestFullscreen();
      } else {
        await player.webkitRequestFullscreen?.();
      }
    } catch {
      fullscreenFeedback.textContent = "Fullscreen could not open. Try again, or keep playing in this window.";
      fullscreenFeedback.hidden = false;
    }
    sync();
  }, { signal: controller.signal });

  doc.addEventListener("fullscreenchange", sync, { signal: controller.signal });
  doc.addEventListener("webkitfullscreenchange", sync, { signal: controller.signal });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) controller.abort();
  }, { signal: controller.signal });
  sync();
}
