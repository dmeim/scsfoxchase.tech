import { Carousel, type Game } from './carousel';
import { initPlaceholderImages } from './placeholder-images';
import { iconExclamationCircle, iconExclamationTriangle } from './icons';
import { uiClassNames } from '../components/ui/dom';

export type { Game };

const PRIMARY_CATEGORY_COLORS: Record<string, { bg: string; textColor: string }> = {
  'Single Player': { bg: '#78909C', textColor: '#fff' },
  Multiplayer: { bg: '#1E88E5', textColor: '#fff' },
  Online: { bg: '#26A69A', textColor: '#fff' },
  Offline: { bg: '#8D6E63', textColor: '#fff' },
  'Turn-Based': { bg: '#AB47BC', textColor: '#fff' },
  'Educational Hub': { bg: '#4CAF50', textColor: '#fff' },
  'Real-Time': { bg: '#FFA726', textColor: '#222' },
  PvP: { bg: '#EF5350', textColor: '#fff' },
  'Co-op': { bg: '#66BB6A', textColor: '#fff' },
};

const SECONDARY_CATEGORY_COLORS: Record<string, { bg: string; textColor: string }> = {
  Action: { bg: '#EF5350', textColor: '#fff' },
  Arcade: { bg: '#FF7043', textColor: '#fff' },
  'Art & Creativity': { bg: '#EC407A', textColor: '#fff' },
  'Battle Royale': { bg: '#E53935', textColor: '#fff' },
  'Board Games': { bg: '#8D6E63', textColor: '#fff' },
  Classics: { bg: '#9575CD', textColor: '#fff' },
  Competitive: { bg: '#F44336', textColor: '#fff' },
  'Daily Challenge': { bg: '#FFA726', textColor: '#222' },
  Educational: { bg: '#26A69A', textColor: '#fff' },
  Geography: { bg: '#29B6F6', textColor: '#fff' },
  'IO Games': { bg: '#00ACC1', textColor: '#fff' },
  Math: { bg: '#4FC3F7', textColor: '#222' },
  Movement: { bg: '#7CB342', textColor: '#fff' },
  Music: { bg: '#F06292', textColor: '#fff' },
  Party: { bg: '#BA68C8', textColor: '#fff' },
  Puzzle: { bg: '#5E35B1', textColor: '#fff' },
  Racing: { bg: '#42A5F5', textColor: '#fff' },
  Sandbox: { bg: '#81C784', textColor: '#222' },
  Science: { bg: '#009688', textColor: '#fff' },
  Sports: { bg: '#2196F3', textColor: '#fff' },
  Strategy: { bg: '#3F51B5', textColor: '#fff' },
  Survival: { bg: '#6D4C41', textColor: '#fff' },
  Trivia: { bg: '#FFC107', textColor: '#222' },
  'Word Games': { bg: '#66BB6A', textColor: '#fff' },
};

function getCategoryChipColor(category: string, isPrimary: boolean) {
  const map = isPrimary ? PRIMARY_CATEGORY_COLORS : SECONDARY_CATEGORY_COLORS;
  return map[category] || { bg: '#9E9E9E', textColor: '#fff' };
}

function openGameUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

class GamesManager {
  gamesGrid: HTMLElement | null;
  searchInput: HTMLInputElement | null;
  gradeChipsContainer: HTMLElement | null;
  primaryCategoryChipsContainer: HTMLElement | null;
  secondaryCategoryChipsContainer: HTMLElement | null;
  allGames: Game[];
  filteredGames: Game[];
  trendingIds: string[];
  selectedGrades = new Set<number>();
  selectedPrimaryCategories = new Set<string>();
  selectedSecondaryCategories = new Set<string>();
  searchQuery = '';
  carousel: Carousel | null = null;
  detailModal: HTMLDialogElement | null = null;
  detailOpener: HTMLElement | null = null;
  detailEscapeHandler: ((event: KeyboardEvent) => void) | null = null;
  previousBodyOverflow = '';

  constructor(games: Game[], trendingIds: string[]) {
    this.gamesGrid = document.getElementById('games-grid');
    this.searchInput = document.getElementById('game-search') as HTMLInputElement | null;
    this.gradeChipsContainer = document.getElementById('grade-chips');
    this.primaryCategoryChipsContainer = document.getElementById('primary-category-chips');
    this.secondaryCategoryChipsContainer = document.getElementById('secondary-category-chips');
    this.allGames = games;
    this.filteredGames = [...games];
    this.trendingIds = trendingIds;
    this.init();
  }

  init() {
    try {
      this.initCarousel();
      this.initFilters();
      this.renderGamesGrid();
      initPlaceholderImages();
    } catch (error) {
      console.error('Error initializing games:', error);
      this.handleError();
    }
  }

  initCarousel() {
    const trendingGames = this.trendingIds
      .map((id) => this.allGames.find((game) => game.id === id))
      .filter((game): game is Game => Boolean(game));

    this.carousel = new Carousel('trending-carousel');
    this.carousel.init(trendingGames);
  }

  initFilters() {
    if (this.searchInput) {
      this.searchInput.addEventListener('input', () => {
        this.searchQuery = this.searchInput!.value.trim().toLowerCase();
        this.filterGames();
        this.renderGamesGrid();
      });
    }

    const bindGroup = <T extends string | number>(
      container: HTMLElement | null,
      selectedSet: Set<T>,
      parse: (value: string) => T,
    ) => {
      container?.addEventListener('ui:change', (event) => {
        const detail = (event as CustomEvent<{ value?: string[] }>).detail;
        selectedSet.clear();
        for (const value of detail?.value ?? []) selectedSet.add(parse(value));
        this.filterGames();
        this.renderGamesGrid();
      });
    };

    bindGroup(this.gradeChipsContainer, this.selectedGrades, (value) => Number(value));
    bindGroup(this.primaryCategoryChipsContainer, this.selectedPrimaryCategories, String);
    bindGroup(this.secondaryCategoryChipsContainer, this.selectedSecondaryCategories, String);
  }

  filterGames() {
    this.filteredGames = this.allGames.filter((game) => {
      if (this.searchQuery) {
        const name = game.name.toLowerCase();
        const desc = (game.description || '').toLowerCase();
        if (!name.includes(this.searchQuery) && !desc.includes(this.searchQuery)) {
          return false;
        }
      }

      if (this.selectedGrades.size > 0) {
        let gradeMatch = false;
        for (const grade of this.selectedGrades) {
          if (game.minGrade <= grade && game.maxGrade >= grade) {
            gradeMatch = true;
            break;
          }
        }
        if (!gradeMatch) return false;
      }

      if (this.selectedPrimaryCategories.size > 0) {
        const gamePrimary = game.primaryCategories || [];
        if (!gamePrimary.some((c) => this.selectedPrimaryCategories.has(c))) {
          return false;
        }
      }

      if (this.selectedSecondaryCategories.size > 0) {
        const gameSecondary = game.secondaryCategories || game.categories || [];
        if (!gameSecondary.some((c) => this.selectedSecondaryCategories.has(c))) {
          return false;
        }
      }

      return true;
    });
  }

  renderGamesGrid() {
    if (!this.gamesGrid) return;
    this.gamesGrid.innerHTML = '';

    if (this.filteredGames.length === 0) {
      this.renderNoGamesMessage();
      return;
    }

    this.filteredGames.forEach((game) => {
      this.gamesGrid!.appendChild(this.createGameCard(game));
    });

    initPlaceholderImages();
  }

  createGameCard(game: Game): HTMLElement {
    // /games Candidate #10 — max media (image + one-line title only)
    if (this.gamesGrid?.dataset.cardStyle === 'max') {
      return this.createMaxMediaCard(game);
    }

    const card = document.createElement('div');
    card.className = uiClassNames.card('game-card');
    card.addEventListener('click', () => {
      window.open(game.url, '_blank');
    });

    const cardImage = document.createElement('div');
    cardImage.classList.add('game-card-image');
    cardImage.style.backgroundImage = `url(${game.image})`;

    const cardContent = document.createElement('div');
    cardContent.classList.add('game-card-content');

    const title = document.createElement('h4');
    title.textContent = game.name;

    const badgeColumns = document.createElement('div');
    badgeColumns.classList.add('game-card-badge-columns');

    const createBadgeColumn = (label: string, categories: string[], isPrimary: boolean) => {
      const column = document.createElement('div');
      column.classList.add('game-card-badge-column');

      const columnLabel = document.createElement('div');
      columnLabel.classList.add('game-card-badge-label');
      columnLabel.textContent = label;
      column.appendChild(columnLabel);

      const row = document.createElement('div');
      row.classList.add('chip-row', isPrimary ? 'chip-row-primary' : 'chip-row-secondary');
      categories.forEach((cat) => {
        const chip = document.createElement('span');
        chip.className = uiClassNames.badge('normal', `chip ${isPrimary ? 'chip-primary' : 'chip-secondary'}`);
        chip.textContent = cat;
        const colors = getCategoryChipColor(cat, isPrimary);
        chip.style.backgroundColor = colors.bg;
        chip.style.color = colors.textColor;
        row.appendChild(chip);
      });
      column.appendChild(row);
      return column;
    };

    const primaryCategories = game.primaryCategories || [];
    const secondaryCategories = game.secondaryCategories || game.categories || [];
    badgeColumns.appendChild(createBadgeColumn('Type', primaryCategories, true));
    badgeColumns.appendChild(createBadgeColumn('Genre', secondaryCategories, false));

    const description = document.createElement('div');
    description.classList.add('game-card-description');
    const descText = document.createElement('p');
    descText.textContent = game.description;
    description.appendChild(descText);

    cardContent.appendChild(title);
    cardContent.appendChild(description);
    cardContent.appendChild(badgeColumns);

    card.appendChild(cardImage);
    card.appendChild(cardContent);

    return card;
  }

  /** Candidate #10 Max media — minimal chrome, 16:9 image, one-line ellipsis title */
  createMaxMediaCard(game: Game): HTMLElement {
    const card = document.createElement('div');
    card.className = uiClassNames.card('game-card game-card--max', { transparent: true });

    const cardImage = document.createElement('a');
    cardImage.classList.add('game-card-image');
    cardImage.style.backgroundImage = `url(${game.image})`;
    cardImage.href = game.url;
    cardImage.target = '_blank';
    cardImage.rel = 'noopener noreferrer';
    cardImage.setAttribute('aria-label', `Play ${game.name}`);

    const title = document.createElement('button');
    title.type = 'button';
    title.className = uiClassNames.button('ghost', 'small', 'game-card-title');
    title.textContent = game.name;
    title.setAttribute('aria-label', `Details for ${game.name}`);
    title.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openGameDetail(game, title);
    });

    card.appendChild(cardImage);
    card.appendChild(title);

    return card;
  }

  ensureDetailModal(): HTMLDialogElement {
    if (this.detailModal) return this.detailModal;
    const modal = document.getElementById('game-detail-modal');
    if (!(modal instanceof HTMLDialogElement)) {
      throw new Error('Game detail dialog is unavailable.');
    }
    modal.addEventListener('close', () => {
      document.body.style.overflow = this.previousBodyOverflow;
      const opener = this.detailOpener;
      this.detailOpener = null;
      queueMicrotask(() => opener?.focus());
    });
    this.detailModal = modal;
    return modal;
  }

  fillDetailModal(game: Game) {
    const modal = this.ensureDetailModal();
    const titleEl = modal.querySelector<HTMLElement>('[data-game-detail-title]');
    const imageBtn = modal.querySelector<HTMLButtonElement>('.game-detail-image-btn');
    const imageEl = modal.querySelector<HTMLImageElement>('.game-detail-image');
    const descEl = modal.querySelector<HTMLParagraphElement>('.game-detail-description p');
    const playBtn = modal.querySelector<HTMLButtonElement>('.game-detail-play');
    const gradeRow = modal.querySelector<HTMLElement>('[data-chip-column="grade"] .chip-row');
    const typeRow = modal.querySelector<HTMLElement>('[data-chip-column="type"] .chip-row');
    const genreRow = modal.querySelector<HTMLElement>('[data-chip-column="genre"] .chip-row');

    if (titleEl) titleEl.textContent = game.name;

    if (imageEl) {
      imageEl.src = game.image;
      imageEl.alt = '';
    }
    if (imageBtn) {
      imageBtn.setAttribute('aria-label', `Play ${game.name}`);
      imageBtn.onclick = () => openGameUrl(game.url);
    }

    if (descEl) descEl.textContent = game.description || '';

    if (playBtn) {
      playBtn.setAttribute('aria-label', `Play ${game.name}`);
      playBtn.onclick = () => openGameUrl(game.url);
    }

    if (gradeRow) {
      gradeRow.innerHTML = '';
      for (let grade = game.minGrade; grade <= game.maxGrade; grade++) {
        const chip = document.createElement('span');
        chip.className = uiClassNames.badge('normal', 'chip chip-grade');
        chip.textContent = String(grade);
        gradeRow.appendChild(chip);
      }
    }

    const fillCategoryRow = (row: HTMLElement | null, categories: string[], isPrimary: boolean) => {
      if (!row) return;
      row.innerHTML = '';
      categories.forEach((cat) => {
        const chip = document.createElement('span');
        chip.className = uiClassNames.badge('normal', `chip ${isPrimary ? 'chip-primary' : 'chip-secondary'}`);
        chip.textContent = cat;
        const colors = getCategoryChipColor(cat, isPrimary);
        chip.style.backgroundColor = colors.bg;
        chip.style.color = colors.textColor;
        row.appendChild(chip);
      });
    };

    fillCategoryRow(typeRow, game.primaryCategories || [], true);
    fillCategoryRow(genreRow, game.secondaryCategories || game.categories || [], false);
  }

  openGameDetail(game: Game, opener: HTMLElement) {
    const modal = this.ensureDetailModal();
    this.fillDetailModal(game);
    this.detailOpener = opener;

    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.showModal();

    const closeBtn = modal.querySelector<HTMLButtonElement>('.game-detail-close');
    queueMicrotask(() => closeBtn?.focus());
  }

  closeGameDetail() {
    if (!this.detailModal?.open) return;

    this.detailModal.close();

    if (this.detailEscapeHandler) {
      document.removeEventListener('keydown', this.detailEscapeHandler);
      this.detailEscapeHandler = null;
    }

  }

  renderNoGamesMessage() {
    if (!this.gamesGrid) return;
    const message = document.createElement('div');
    message.className = uiClassNames.feedback('info', 'no-games-message');
    message.innerHTML = `
      ${iconExclamationCircle}
      <h3>No Games Found</h3>
      <p>There are no games available for the selected grade level.</p>
    `;
    this.gamesGrid.appendChild(message);
  }

  handleError() {
    if (this.gamesGrid) {
      this.gamesGrid.innerHTML = `
        <div class="${uiClassNames.feedback('error', 'error-message')}">
          ${iconExclamationTriangle}
          <h3>Error Loading Games</h3>
          <p>There was a problem loading the games. Please try again later.</p>
        </div>
      `;
    }

    const carousel = document.getElementById('trending-carousel');
    if (carousel) {
      carousel.innerHTML = `
        <li class="carousel-slide">
          <div class="carousel-slide-inner">
            <div class="carousel-slide-content">
              <h4>Error Loading Trending Games</h4>
              <p>There was a problem loading the trending games. Please try again later.</p>
            </div>
          </div>
        </li>
      `;
    }
  }
}

/**
 * Initialize the games catalog from build-time embedded data (no client fetches).
 */
export function initGamesCatalog(games: Game[], trendingIds: string[]) {
  if (!document.getElementById('games-grid')) return;
  new GamesManager(games, trendingIds);
}
