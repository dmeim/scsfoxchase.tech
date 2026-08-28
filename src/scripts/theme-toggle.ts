// Theme preference behavior for the shared SegmentedControl rendered by Header.astro.

type ThemePreference = 'light' | 'dark' | 'system';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

class ThemeToggle {
  /** Stored choice: light, dark, or follow OS. */
  preference: ThemePreference;
  /** Resolved appearance applied to the page. */
  currentTheme: 'light' | 'dark';

  constructor() {
    this.preference = this.getStoredPreference() ?? 'system';
    this.currentTheme = this.resolveTheme(this.preference);
    this.init();
  }

  init() {
    this.applyPreference(this.preference);
    this.setupEventListeners();
  }

  getSystemTheme(): 'light' | 'dark' {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  resolveTheme(preference: ThemePreference): 'light' | 'dark' {
    return preference === 'system' ? this.getSystemTheme() : preference;
  }

  setupEventListeners() {
    const group = document.getElementById('theme-toggle');
    if (!group) return;

    group.addEventListener('ui:change', (event) => {
      const next = (event as CustomEvent<{ value?: string }>).detail?.value;
      if (!isThemePreference(next)) return;
      this.setPreference(next);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (this.preference !== 'system') return;
      this.currentTheme = e.matches ? 'dark' : 'light';
      this.applyResolvedTheme(this.currentTheme);
    });
  }

  setPreference(preference: ThemePreference) {
    this.preference = preference;
    this.storePreference(preference);
    this.applyPreference(preference);
  }

  applyPreference(preference: ThemePreference) {
    this.preference = preference;
    this.currentTheme = this.resolveTheme(preference);
    document.documentElement.setAttribute('data-theme-pref', preference);
    this.applyResolvedTheme(this.currentTheme);
    this.syncOptionState();
  }

  applyResolvedTheme(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeIcons(theme);
  }

  syncOptionState() {
    document.querySelectorAll<HTMLElement>('#theme-toggle [data-ui-segmented-value]').forEach((btn) => {
      const selected = btn.dataset.uiSegmentedValue === this.preference;
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
    });
  }

  updateThemeIcons(theme: string) {
    document.querySelectorAll<HTMLImageElement>('.theme-icon').forEach((img) => {
      const src = theme === 'dark' ? img.dataset.dark : img.dataset.light;
      if (src) img.src = src;
    });
  }

  getStoredPreference(): ThemePreference | null {
    try {
      const value = localStorage.getItem('theme');
      // Legacy: older builds stored only light/dark; keep those as explicit prefs.
      if (isThemePreference(value)) return value;
      return null;
    } catch {
      return null;
    }
  }

  storePreference(preference: ThemePreference) {
    try {
      localStorage.setItem('theme', preference);
    } catch {
      // ignore quota / private mode
    }
  }
}

function mountThemeToggle() {
  new ThemeToggle();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountThemeToggle);
} else {
  mountThemeToggle();
}
