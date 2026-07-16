import { Carousel, type Game } from './carousel';
import { initPlaceholderImages } from './placeholder-images';
import { iconExclamationCircle, iconExclamationTriangle } from './icons';

export type { Game };

const PRIMARY_CATEGORY_COLORS: Record<string, { bg: string; textColor: string }> = {
  'Single Player': { bg: '#78909C', textColor: '#fff' },
  Multiplayer: { bg: '#1E88E5', textColor: '#fff' },
  Online: { bg: '#26A69A', textColor: '#fff' },
  Offline: { bg: '#8D6E63', textColor: '#fff' },
  'Co-op': { bg: '#66BB6A', textColor: '#fff' },
  PvP: { bg: '#EF5350', textColor: '#fff' },
  'Turn-Based': { bg: '#AB47BC', textColor: '#fff' },
  'Real-Time': { bg: '#FFA726', textColor: '#222' },
  'Free to Play': { bg: '#4CAF50', textColor: '#fff' },
};

const SECONDARY_CATEGORY_COLORS: Record<string, { bg: string; textColor: string }> = {
  Action: { bg: '#EF5350', textColor: '#fff' },
  Adventure: { bg: '#AB47BC', textColor: '#fff' },
  Arcade: { bg: '#FF7043', textColor: '#fff' },
  'Art & Creativity': { bg: '#EC407A', textColor: '#fff' },
  'Board Games': { bg: '#8D6E63', textColor: '#fff' },
  'Brain Teaser': { bg: '#5C6BC0', textColor: '#fff' },
  Building: { bg: '#78909C', textColor: '#fff' },
  'Card Games': { bg: '#7E57C2', textColor: '#fff' },
  Casual: { bg: '#26C6DA', textColor: '#222' },
  Classics: { bg: '#9575CD', textColor: '#fff' },
  Competitive: { bg: '#F44336', textColor: '#fff' },
  Cooking: { bg: '#FF8A65', textColor: '#222' },
  Crossword: { bg: '#4DB6AC', textColor: '#fff' },
  'Daily Challenge': { bg: '#FFA726', textColor: '#222' },
  'Driving & Racing': { bg: '#42A5F5', textColor: '#fff' },
  Educational: { bg: '#26A69A', textColor: '#fff' },
  'Endless Runner': { bg: '#FFCA28', textColor: '#222' },
  Exploration: { bg: '#66BB6A', textColor: '#fff' },
  'FPS / Shooter': { bg: '#E53935', textColor: '#fff' },
  Geography: { bg: '#29B6F6', textColor: '#fff' },
  Holiday: { bg: '#D32F2F', textColor: '#fff' },
  'IO Games': { bg: '#00ACC1', textColor: '#fff' },
  Kids: { bg: '#FFB74D', textColor: '#222' },
  Logic: { bg: '#7986CB', textColor: '#fff' },
  Math: { bg: '#4FC3F7', textColor: '#222' },
  Memory: { bg: '#CE93D8', textColor: '#222' },
  'Minecraft-Style': { bg: '#4CAF50', textColor: '#fff' },
  'Mouse Skill': { bg: '#B0BEC5', textColor: '#222' },
  Music: { bg: '#F06292', textColor: '#fff' },
  'Number Puzzles': { bg: '#FFD54F', textColor: '#222' },
  'Obstacle Course': { bg: '#FF5722', textColor: '#fff' },
  'Open World': { bg: '#43A047', textColor: '#fff' },
  Party: { bg: '#BA68C8', textColor: '#fff' },
  Physics: { bg: '#90A4AE', textColor: '#222' },
  Platformer: { bg: '#FF9800', textColor: '#222' },
  Puzzle: { bg: '#5E35B1', textColor: '#fff' },
  'Reaction Speed': { bg: '#FFEE58', textColor: '#222' },
  Retro: { bg: '#A1887F', textColor: '#fff' },
  Sandbox: { bg: '#81C784', textColor: '#222' },
  Science: { bg: '#009688', textColor: '#fff' },
  Spelling: { bg: '#AED581', textColor: '#222' },
  Sports: { bg: '#2196F3', textColor: '#fff' },
  Strategy: { bg: '#3F51B5', textColor: '#fff' },
  Survival: { bg: '#6D4C41', textColor: '#fff' },
  'Tile Matching': { bg: '#4DD0E1', textColor: '#222' },
  Trivia: { bg: '#FFC107', textColor: '#222' },
  Typing: { bg: '#A5D6A7', textColor: '#222' },
  'Word Games': { bg: '#66BB6A', textColor: '#fff' },
};

function getCategoryChipColor(category: string, isPrimary: boolean) {
  const map = isPrimary ? PRIMARY_CATEGORY_COLORS : SECONDARY_CATEGORY_COLORS;
  return map[category] || { bg: '#9E9E9E', textColor: '#fff' };
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
    card.addEventListener('click', () => {
      window.open(game.url, '_blank');
    });

    const cardImage = document.createElement('div');
    cardImage.classList.add('game-card-image');
    cardImage.style.backgroundImage = `url(${game.image})`;

    const title = document.createElement('h4');
    title.textContent = game.name;

    card.appendChild(cardImage);
    card.appendChild(title);

    return card;
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
