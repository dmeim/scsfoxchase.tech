import {
  DINO_RUN, createDinoRun, parseDinoBest, pauseDinoRun, releaseDinoJump,
  restartDinoRun, resumeDinoRun, slamDino, startDinoJump, stepDinoRun,
} from "../lib/minigames/dino-run";
import { createDinoRenderer } from "../lib/minigames/dino-renderer";
import { iconPause, iconPlay } from "./icons";

export function initDinoRun(canvas: HTMLCanvasElement): void {
  const frame = canvas.closest<HTMLElement>("[data-minigame-frame]");
  if (!frame) throw new Error("Dino Run needs a mini-game frame.");
  const player = frame;
  const controller = new AbortController();
  const signal = controller.signal;
  const required = <T extends HTMLElement>(selector: string): T => {
    const element = player.querySelector<T>(selector);
    if (!element) throw new Error(`Dino Run is missing ${selector}.`);
    return element;
  };
  const overlay = required("[data-dino-overlay]");
  const title = required("[data-dino-title]");
  const message = required("[data-dino-message]");
  const action = required<HTMLButtonElement>("[data-dino-action]");
  const pauseButton = required<HTMLButtonElement>("[data-dino-pause]");
  const score = required("[data-dino-score]");
  const best = required("[data-dino-best]");
  const lives = required("[data-dino-lives]");
  const announcement = required("[data-dino-announcement]");
  const feedback = required("[data-minigame-feedback]");
  const hearts = [...player.querySelectorAll<HTMLElement>("[data-dino-heart]")];

  let storedBest = 0;
  try {
    storedBest = parseDinoBest(localStorage.getItem(DINO_RUN.bestScoreKey));
  } catch {
    console.warn("Dino Run best score storage is unavailable.");
  }
  const game = createDinoRun(storedBest);
  let renderer: ReturnType<typeof createDinoRenderer>;
  try {
    renderer = createDinoRenderer(canvas, game);
  } catch {
    title.textContent = "Dino Run could not start";
    message.textContent = "Try a browser with canvas support, then reload this page.";
    action.hidden = true;
    return;
  }

  let raf = 0;
  let lastTime = 0;
  let accumulator = 0;
  let previousStatus = game.status;
  const jumpSources = new Set<string>();
  const pressedKeys = new Set<string>();

  function persistBest(): void {
    if (game.best <= storedBest) return;
    try {
      localStorage.setItem(DINO_RUN.bestScoreKey, String(game.best));
      storedBest = game.best;
    } catch {
      feedback.textContent = "Your best score could not be saved on this device. You can still keep playing.";
      feedback.hidden = false;
      console.warn("Dino Run best score could not be saved.");
    }
  }

  function syncUi(): void {
    score.textContent = String(Math.floor(game.score)).padStart(5, "0");
    best.textContent = String(game.best).padStart(5, "0");
    lives.setAttribute("aria-label", `${game.hearts} of ${DINO_RUN.maxHearts} lives`);
    hearts.forEach((heart, index) => { heart.dataset.empty = String(index < DINO_RUN.maxHearts - game.hearts); });
    overlay.hidden = game.status === "running";
    pauseButton.disabled = game.status === "ready" || game.status === "gameover";
    if (game.status === previousStatus) return;
    previousStatus = game.status;

    const paused = game.status === "paused";
    const pauseLabel = paused ? "Resume game (P)" : "Pause game (P)";
    pauseButton.setAttribute("aria-label", pauseLabel);
    pauseButton.title = pauseLabel;
    const pauseIcon = pauseButton.querySelector("span");
    if (pauseIcon) pauseIcon.innerHTML = paused ? iconPlay : iconPause;

    if (game.status === "gameover") {
      persistBest();
      title.textContent = "Game over";
      message.textContent = `You scored ${Math.floor(game.score)}. Your best is ${game.best}.`;
      action.textContent = "Play again";
      announcement.textContent = message.textContent;
    } else if (paused) {
      title.textContent = "Paused";
      message.textContent = "Take a breather. Your run is right here.";
      action.textContent = "Resume run";
      announcement.textContent = "Game paused.";
    } else {
      announcement.textContent = "Run started. Space to jump, Shift to slam, P to pause.";
    }
  }

  function loop(now: number): void {
    raf = 0;
    const elapsed = lastTime ? now - lastTime : 0;
    lastTime = now;
    accumulator += elapsed > 250 ? DINO_RUN.stepMs : elapsed;
    let steps = 0;
    while (accumulator >= DINO_RUN.stepMs && steps < DINO_RUN.maxStepsPerFrame) {
      stepDinoRun(game);
      accumulator -= DINO_RUN.stepMs;
      steps += 1;
    }
    if (steps === DINO_RUN.maxStepsPerFrame) accumulator = 0;
    syncUi();
    renderer.draw();
    if (game.status === "running") raf = requestAnimationFrame(loop);
  }

  function refresh(): void {
    syncUi();
    renderer.draw();
    if (game.status === "running" && !raf) {
      lastTime = 0;
      accumulator = 0;
      raf = requestAnimationFrame(loop);
    } else if (game.status !== "running") {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function releaseInputs(): void {
    jumpSources.clear();
    pressedKeys.clear();
    releaseDinoJump(game);
  }

  function pause(): void {
    releaseInputs();
    pauseDinoRun(game);
    refresh();
  }

  function togglePause(): void {
    if (game.status === "paused") resumeDinoRun(game);
    else pause();
    canvas.focus({ preventScroll: true });
    refresh();
  }

  function restart(): void {
    releaseInputs();
    restartDinoRun(game);
    canvas.focus({ preventScroll: true });
    refresh();
  }

  action.addEventListener("click", () => {
    if (game.status === "paused") togglePause();
    else restart();
  }, { signal });
  pauseButton.addEventListener("click", togglePause, { signal });
  required("[data-dino-restart]").addEventListener("click", restart, { signal });

  function jumpDown(source: string): void {
    if (jumpSources.has(source)) return;
    jumpSources.add(source);
    startDinoJump(game);
    refresh();
  }

  function jumpUp(source: string): void {
    jumpSources.delete(source);
    if (jumpSources.size === 0) releaseDinoJump(game);
    refresh();
  }

  function keyboardBelongsToGame(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.altKey || event.metaKey || !player.contains(document.activeElement)) return false;
    return !(event.target instanceof Element &&
      event.target.closest("button, a, input, textarea, select, [contenteditable], [role='dialog']"));
  }

  window.addEventListener("keydown", (event) => {
    if (!keyboardBelongsToGame(event)) return;
    const jump = event.code === "Space" || event.code === "ArrowUp";
    const slam = event.code === "ShiftLeft" || event.code === "ShiftRight";
    if (!jump && !slam && !["KeyP", "KeyR", "Escape"].includes(event.code)) return;
    if (event.code !== "Escape") event.preventDefault();
    if (event.repeat || pressedKeys.has(event.code)) return;
    pressedKeys.add(event.code);
    if (jump) jumpDown(`key:${event.code}`);
    else if (slam) { slamDino(game); refresh(); }
    else if (event.code === "KeyP") togglePause();
    else if (event.code === "KeyR") restart();
    else if (game.status === "running") pause();
  }, { signal });
  window.addEventListener("keyup", (event) => {
    pressedKeys.delete(event.code);
    const source = `key:${event.code}`;
    if (jumpSources.has(source)) jumpUp(source);
  }, { signal });

  const jumpButton = required<HTMLButtonElement>("[data-dino-jump]");
  const slamButton = required<HTMLButtonElement>("[data-dino-slam]");
  const jumpTargets: HTMLElement[] = [canvas, jumpButton];
  for (const target of jumpTargets) {
    target.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      target.setPointerCapture(event.pointerId);
      jumpDown(`pointer:${event.pointerId}`);
    }, { signal });
    const release = (event: PointerEvent) => jumpUp(`pointer:${event.pointerId}`);
    target.addEventListener("pointerup", release, { signal });
    target.addEventListener("pointercancel", release, { signal });
    target.addEventListener("lostpointercapture", release, { signal });
  }
  jumpButton.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    canvas.focus({ preventScroll: true });
    startDinoJump(game);
    releaseDinoJump(game);
    refresh();
  }, { signal });
  slamButton.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    slamDino(game);
    refresh();
  }, { signal });
  slamButton.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    canvas.focus({ preventScroll: true });
    slamDino(game);
    refresh();
  }, { signal });

  window.addEventListener("blur", pause, { signal });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  }, { signal });
  player.addEventListener("minigame:fullscreenchange", (event) => {
    if ((event as CustomEvent<{ active: boolean }>).detail.active) canvas.focus({ preventScroll: true });
  }, { signal });
  window.addEventListener("pagehide", (event) => {
    pause();
    if (event.persisted) return;
    controller.abort();
    renderer.destroy();
  }, { signal });

  syncUi();
  canvas.focus({ preventScroll: true });
}
