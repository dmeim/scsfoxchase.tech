import { Carousel, type Game } from './carousel';
import { initPlaceholderImages } from './placeholder-images';
import { iconExclamationCircle, iconExclamationTriangle, iconTimes } from './icons';

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
  detailModal: HTMLElement | null = null;
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

    if (this.gradeChipsContainer) {
      this.gradeChipsContainer.querySelectorAll<HTMLElement>('.filter-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const grade = parseInt(chip.dataset.grade || '', 10);
          if (this.selectedGrades.has(grade)) {
            this.selectedGrades.delete(grade);
            chip.classList.remove('active');
          } else {
            this.selectedGrades.add(grade);
            chip.classList.add('active');
          }
          this.filterGames();
          this.renderGamesGrid();
        });
      });
    }

    this.buildCategoryChips();
  }

  buildCategoryChips() {
    const primarySet = new Set<string>();
    const secondarySet = new Set<string>();

    this.allGames.forEach((game) => {
      (game.primaryCategories || []).forEach((c) => primarySet.add(c));
      (game.secondaryCategories || game.categories || []).forEach((c) => secondarySet.add(c));
    });

    const createChips = (
      container: HTMLElement | null,
      categories: Set<string>,
      selectedSet: Set<string>,
    ) => {
      if (!container) return;
      container.innerHTML = '';
      [...categories].sort().forEach((cat) => {
        const chip = document.createElement('span');
        chip.classList.add('filter-chip');
        chip.textContent = cat;
        chip.addEventListener('click', () => {
          if (selectedSet.has(cat)) {
            selectedSet.delete(cat);
            chip.classList.remove('active');
          } else {
            selectedSet.add(cat);
            chip.classList.add('active');
          }
          this.filterGames();
          this.renderGamesGrid();
        });
        container.appendChild(chip);
      });
    };

    createChips(this.primaryCategoryChipsContainer, primarySet, this.selectedPrimaryCategories);
    createChips(
      this.secondaryCategoryChipsContainer,
      secondarySet,
      this.selectedSecondaryCategories,
    );
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
    card.classList.add('game-card');
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
        chip.classList.add('chip', isPrimary ? 'chip-primary' : 'chip-secondary');
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
    card.classList.add('game-card', 'game-card--max');

    const cardImage = document.createElement('div');
    cardImage.classList.add('game-card-image');
    cardImage.style.backgroundImage = `url(${game.image})`;
    cardImage.setAttribute('role', 'link');
    cardImage.tabIndex = 0;
    cardImage.setAttribute('aria-label', `Play ${game.name}`);
    cardImage.addEventListener('click', (event) => {
      event.stopPropagation();
      openGameUrl(game.url);
    });
    cardImage.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openGameUrl(game.url);
      }
    });

    const title = document.createElement('h4');
    title.classList.add('game-card-title');
    title.textContent = game.name;
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
    title.setAttribute('aria-label', `Details for ${game.name}`);
    title.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openGameDetail(game, title);
    });
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openGameDetail(game, title);
      }
    });

    card.appendChild(cardImage);
    card.appendChild(title);

    return card;
  }

  ensureDetailModal(): HTMLElement {
    if (this.detailModal) return this.detailModal;

    const modal = document.createElement('div');
    modal.id = 'game-detail-modal';
    modal.className = 'game-detail-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="game-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="game-detail-title">
        <button type="button" class="game-detail-close" aria-label="Close">${iconTimes}</button>
        <div class="game-detail-body">
          <button type="button" class="game-detail-image-btn" aria-label="Play game">
            <img class="game-detail-image" alt="" />
          </button>
          <h2 id="game-detail-title" class="game-detail-title"></h2>
          <div class="game-detail-chips">
            <div class="game-detail-chip-column" data-chip-column="grade">
              <div class="game-card-badge-label">Grade</div>
              <div class="chip-row chip-row-grades"></div>
            </div>
            <div class="game-detail-chip-column" data-chip-column="type">
              <div class="game-card-badge-label">Type</div>
              <div class="chip-row chip-row-primary"></div>
            </div>
            <div class="game-detail-chip-column" data-chip-column="genre">
              <div class="game-card-badge-label">Genre</div>
              <div class="chip-row chip-row-secondary"></div>
            </div>
          </div>
          <div class="game-detail-description">
            <p></p>
          </div>
          <button type="button" class="game-detail-play">Play</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', (event) => {
      if (event.target === modal) this.closeGameDetail();
    });

    const closeBtn = modal.querySelector<HTMLButtonElement>('.game-detail-close');
    closeBtn?.addEventListener('click', () => this.closeGameDetail());

    document.body.appendChild(modal);
    this.detailModal = modal;
    return modal;
  }

  fillDetailModal(game: Game) {
    const modal = this.ensureDetailModal();
    const titleEl = modal.querySelector<HTMLElement>('#game-detail-title');
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
        chip.classList.add('chip', 'chip-grade');
        chip.textContent = String(grade);
        gradeRow.appendChild(chip);
      }
    }

    const fillCategoryRow = (row: HTMLElement | null, categories: string[], isPrimary: boolean) => {
      if (!row) return;
      row.innerHTML = '';
      categories.forEach((cat) => {
        const chip = document.createElement('span');
        chip.classList.add('chip', isPrimary ? 'chip-primary' : 'chip-secondary');
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
    modal.hidden = false;

    if (!this.detailEscapeHandler) {
      this.detailEscapeHandler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') this.closeGameDetail();
      };
      document.addEventListener('keydown', this.detailEscapeHandler);
    }

    const closeBtn = modal.querySelector<HTMLButtonElement>('.game-detail-close');
    queueMicrotask(() => closeBtn?.focus());
  }

  closeGameDetail() {
    if (!this.detailModal || this.detailModal.hidden) return;

    this.detailModal.hidden = true;
    document.body.style.overflow = this.previousBodyOverflow;

    if (this.detailEscapeHandler) {
      document.removeEventListener('keydown', this.detailEscapeHandler);
      this.detailEscapeHandler = null;
    }

    const opener = this.detailOpener;
    this.detailOpener = null;
    queueMicrotask(() => opener?.focus());
  }

  renderNoGamesMessage() {
    if (!this.gamesGrid) return;
    const message = document.createElement('div');
    message.classList.add('no-games-message');
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
        <div class="error-message">
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
