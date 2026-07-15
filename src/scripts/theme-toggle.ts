// Ported from js/theme-toggle.js — ESM, same localStorage key + data-theme behavior

class ThemeToggle {
  currentTheme: string;
  userOverride = false;

  constructor() {
    this.currentTheme = this.getStoredTheme() || this.getSystemTheme();
    this.init();
  }

  init() {
    this.createThemeToggle();
    this.applyTheme(this.currentTheme);
    this.setupEventListeners();
  }

  getSystemTheme(): string {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  createThemeToggle() {
    const headerRight = document.querySelector('.header-right');
    if (!headerRight) return;

    // Avoid duplicate buttons on client navigations / re-imports
    if (document.getElementById('theme-toggle-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'theme-toggle-btn';
    btn.id = 'theme-toggle-btn';
    btn.setAttribute('aria-label', 'Toggle theme');
    btn.innerHTML = `<i class="${this.currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon'}" id="theme-icon"></i>`;
    headerRight.appendChild(btn);
  }

  setupEventListeners() {
    const toggleBtn = document.getElementById('theme-toggle-btn');
    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', () => {
      const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
      this.userOverride = true;
      this.setTheme(newTheme);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!this.getStoredTheme()) {
        this.setTheme(e.matches ? 'dark' : 'light', false);
      }
    });
  }

  setTheme(theme: string, store = true) {
    this.currentTheme = theme;
    this.applyTheme(theme);
    if (store) this.storeTheme(theme);
    this.updateIcon();
  }

  applyTheme(theme: string) {
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeIcons(theme);
  }

  updateThemeIcons(theme: string) {
    document.querySelectorAll<HTMLImageElement>('.theme-icon').forEach((img) => {
      const src = theme === 'dark' ? img.dataset.dark : img.dataset.light;
      if (src) img.src = src;
    });
  }

  updateIcon() {
    const icon = document.getElementById('theme-icon');
    if (!icon) return;
    icon.className = this.currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  }

  getStoredTheme(): string | null {
    try {
      return localStorage.getItem('theme');
    } catch {
      return null;
    }
  }

  storeTheme(theme: string) {
    try {
      localStorage.setItem('theme', theme);
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
