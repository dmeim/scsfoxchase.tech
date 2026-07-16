// Ported from js/theme-toggle.js — ESM, localStorage key + data-theme behavior
import { createElement, Moon, Sun, SunMoon } from 'lucide';

type ThemePreference = 'light' | 'dark' | 'system';

function isThemePreference(value: string | null): value is ThemePreference {
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
    this.createThemeToggle();
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

  iconEl(Icon: typeof Sun, id: string): SVGElement {
    return createElement(Icon, {
      id,
      'aria-hidden': 'true',
      width: '1em',
      height: '1em',
    });
  }

  createThemeToggle() {
    const headerRight = document.querySelector('.header-right');
    if (!headerRight) return;

    if (document.getElementById('theme-toggle')) return;

    const group = document.createElement('div');
    group.className = 'theme-toggle';
    group.id = 'theme-toggle';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Color theme');

    const thumb = document.createElement('span');
    thumb.className = 'theme-toggle-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    group.appendChild(thumb);

    const options: { preference: ThemePreference; label: string; Icon: typeof Sun }[] = [
      { preference: 'light', label: 'Light', Icon: Sun },
      { preference: 'system', label: 'System', Icon: SunMoon },
      { preference: 'dark', label: 'Dark', Icon: Moon },
    ];

    for (const { preference, label, Icon } of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-toggle-option';
      btn.dataset.themeOption = preference;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', label);
      btn.replaceChildren(this.iconEl(Icon, `theme-icon-${preference}`));
      group.appendChild(btn);
    }

    headerRight.appendChild(group);
    this.syncOptionState();
  }

  setupEventListeners() {
    const group = document.getElementById('theme-toggle');
    if (!group) return;

    group.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const option = target?.closest<HTMLElement>('[data-theme-option]');
      if (!option || !group.contains(option)) return;

      const next = option.dataset.themeOption;
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
    document.querySelectorAll<HTMLElement>('[data-theme-option]').forEach((btn) => {
      const selected = btn.dataset.themeOption === this.preference;
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
