/**
 * Returns a background color and text color for a grade range chip.
 * Uses a 2D HSL mapping: minGrade controls hue, maxGrade controls saturation.
 */
function getGradeColor(minGrade, maxGrade) {
    const hue = Math.round(((minGrade - 1) / 7) * 280);
    const saturation = 45 + Math.round(((maxGrade - 1) / 7) * 40);
    const lightness = 65 - Math.round(((maxGrade - 1) / 7) * 20);
    const bg = `hsl(${hue}, ${saturation}%, ${lightness}%)`;

    // Determine text color based on luminance
    const l = lightness / 100;
    const s = saturation / 100;
    const a = s * Math.min(l, 1 - l);
    const rNorm = l - a * Math.max(-1, Math.min(hue / 30 - 4, Math.min(8 - hue / 30, 1)));
    const textColor = l < 0.55 ? '#fff' : '#222';

    return { bg, textColor };
}

/**
 * Returns a background color and text color for a grade chip based on maxGrade.
 */
const GRADE_COLORS = {
    1: { bg: '#4FC3F7', textColor: '#222' },  // Light Blue
    2: { bg: '#4DD0E1', textColor: '#222' },  // Cyan
    3: { bg: '#4DB6AC', textColor: '#222' },  // Teal
    4: { bg: '#81C784', textColor: '#222' },  // Green
    5: { bg: '#FFD54F', textColor: '#222' },  // Amber
    6: { bg: '#FFB74D', textColor: '#222' },  // Orange
    7: { bg: '#FF8A65', textColor: '#fff' },  // Deep Orange
    8: { bg: '#E57373', textColor: '#fff' },  // Red
};

function getGradeChipColor(maxGrade) {
    return GRADE_COLORS[maxGrade] || { bg: '#9E9E9E', textColor: '#fff' };
}

// Primary categories - universal game traits (outlined chips)
const PRIMARY_CATEGORY_COLORS = {
    'Single Player':  { bg: '#78909C', textColor: '#fff' },
    'Multiplayer':    { bg: '#1E88E5', textColor: '#fff' },
    'Online':         { bg: '#26A69A', textColor: '#fff' },
    'Offline':        { bg: '#8D6E63', textColor: '#fff' },
    'Co-op':          { bg: '#66BB6A', textColor: '#fff' },
    'PvP':            { bg: '#EF5350', textColor: '#fff' },
    'Turn-Based':     { bg: '#AB47BC', textColor: '#fff' },
    'Real-Time':      { bg: '#FFA726', textColor: '#222' },
    'Free to Play':   { bg: '#4CAF50', textColor: '#fff' },
};

// Secondary categories - gameplay styles and genres (filled chips)
const SECONDARY_CATEGORY_COLORS = {
    'Action':           { bg: '#EF5350', textColor: '#fff' },
    'Adventure':        { bg: '#AB47BC', textColor: '#fff' },
    'Arcade':           { bg: '#FF7043', textColor: '#fff' },
    'Art & Creativity': { bg: '#EC407A', textColor: '#fff' },
    'Board Games':      { bg: '#8D6E63', textColor: '#fff' },
    'Brain Teaser':     { bg: '#5C6BC0', textColor: '#fff' },
    'Building':         { bg: '#78909C', textColor: '#fff' },
    'Card Games':       { bg: '#7E57C2', textColor: '#fff' },
    'Casual':           { bg: '#26C6DA', textColor: '#222' },
    'Classics':         { bg: '#9575CD', textColor: '#fff' },
    'Competitive':      { bg: '#F44336', textColor: '#fff' },
    'Cooking':          { bg: '#FF8A65', textColor: '#222' },
    'Crossword':        { bg: '#4DB6AC', textColor: '#fff' },
    'Daily Challenge':  { bg: '#FFA726', textColor: '#222' },
    'Driving & Racing': { bg: '#42A5F5', textColor: '#fff' },
    'Educational':      { bg: '#26A69A', textColor: '#fff' },
    'Endless Runner':   { bg: '#FFCA28', textColor: '#222' },
    'Exploration':      { bg: '#66BB6A', textColor: '#fff' },
    'FPS / Shooter':    { bg: '#E53935', textColor: '#fff' },
    'Geography':        { bg: '#29B6F6', textColor: '#fff' },
    'Holiday':          { bg: '#D32F2F', textColor: '#fff' },
    'IO Games':         { bg: '#00ACC1', textColor: '#fff' },
    'Kids':             { bg: '#FFB74D', textColor: '#222' },
    'Logic':            { bg: '#7986CB', textColor: '#fff' },
    'Math':             { bg: '#4FC3F7', textColor: '#222' },
    'Memory':           { bg: '#CE93D8', textColor: '#222' },
    'Minecraft-Style':  { bg: '#4CAF50', textColor: '#fff' },
    'Mouse Skill':      { bg: '#B0BEC5', textColor: '#222' },
    'Music':            { bg: '#F06292', textColor: '#fff' },
    'Number Puzzles':   { bg: '#FFD54F', textColor: '#222' },
    'Obstacle Course':  { bg: '#FF5722', textColor: '#fff' },
    'Open World':       { bg: '#43A047', textColor: '#fff' },
    'Party':            { bg: '#BA68C8', textColor: '#fff' },
    'Physics':          { bg: '#90A4AE', textColor: '#222' },
    'Platformer':       { bg: '#FF9800', textColor: '#222' },
    'Puzzle':           { bg: '#5E35B1', textColor: '#fff' },
    'Reaction Speed':   { bg: '#FFEE58', textColor: '#222' },
    'Retro':            { bg: '#A1887F', textColor: '#fff' },
    'Sandbox':          { bg: '#81C784', textColor: '#222' },
    'Science':          { bg: '#009688', textColor: '#fff' },
    'Spelling':         { bg: '#AED581', textColor: '#222' },
    'Sports':           { bg: '#2196F3', textColor: '#fff' },
    'Strategy':         { bg: '#3F51B5', textColor: '#fff' },
    'Survival':         { bg: '#6D4C41', textColor: '#fff' },
    'Tile Matching':    { bg: '#4DD0E1', textColor: '#222' },
    'Trivia':           { bg: '#FFC107', textColor: '#222' },
    'Typing':           { bg: '#A5D6A7', textColor: '#222' },
    'Word Games':       { bg: '#66BB6A', textColor: '#fff' },
};

function getCategoryChipColor(category, isPrimary) {
    const map = isPrimary ? PRIMARY_CATEGORY_COLORS : SECONDARY_CATEGORY_COLORS;
    return map[category] || { bg: '#9E9E9E', textColor: '#fff' };
}

/**
 * Games Component
 * Handles fetching and rendering games data
 */
class GamesManager {
    constructor() {
        // DOM elements
        this.gamesGrid = document.getElementById('games-grid');
        this.searchInput = document.getElementById('game-search');
        this.gradeChipsContainer = document.getElementById('grade-chips');
        this.primaryCategoryChipsContainer = document.getElementById('primary-category-chips');
        this.secondaryCategoryChipsContainer = document.getElementById('secondary-category-chips');

        // Data
        this.allGames = [];
        this.filteredGames = [];
        this.trendingIds = [];
        this.selectedGrades = new Set();
        this.selectedPrimaryCategories = new Set();
        this.selectedSecondaryCategories = new Set();
        this.searchQuery = '';

        // Carousel
        this.carousel = null;

        // Initialize
        this.init();
    }
    
    /**
     * Initialize the games manager
     */
    async init() {
        try {
            // Fetch games data
            await this.fetchGames();
            
            // Initialize carousel
            this.initCarousel();
            
            // Initialize filters
            this.initFilters();
            
            // Render games grid
            this.renderGamesGrid();
        } catch (error) {
            console.error('Error initializing games:', error);
            this.handleError();
        }
    }
    
    /**
     * Fetch games data from individual JSON files
     */
    async fetchGames() {
        try {
            // Fetch the game index and trending list in parallel
            const [indexRes, trendingRes] = await Promise.all([
                fetch('/data/games/_index.json'),
                fetch('/data/games/_trending.json')
            ]);

            if (!indexRes.ok) throw new Error(`Failed to load game index: ${indexRes.status}`);
            if (!trendingRes.ok) throw new Error(`Failed to load trending list: ${trendingRes.status}`);

            const gameIds = await indexRes.json();
            this.trendingIds = await trendingRes.json();

            // Fetch all individual game files in parallel
            const gameResponses = await Promise.all(
                gameIds.map(id => fetch(`/data/games/${id}.json`).then(r => {
                    if (!r.ok) throw new Error(`Failed to load game: ${id}`);
                    return r.json();
                }))
            );

            this.allGames = gameResponses;
            this.filteredGames = [...this.allGames];
        } catch (error) {
            console.error('Error fetching games data:', error);
            throw error;
        }
    }

    /**
     * Initialize the carousel with trending games
     */
    initCarousel() {
        // Look up trending games by ID from the separate trending list
        const trendingGames = this.trendingIds
            .map(id => this.allGames.find(game => game.id === id))
            .filter(Boolean);

        // Initialize carousel
        this.carousel = new Carousel('trending-carousel');
        this.carousel.init(trendingGames);
    }
    
    /**
     * Initialize search and filter chips
     */
    initFilters() {
        // Search input
        if (this.searchInput) {
            this.searchInput.addEventListener('input', () => {
                this.searchQuery = this.searchInput.value.trim().toLowerCase();
                this.filterGames();
                this.renderGamesGrid();
            });
        }

        // Grade chips
        if (this.gradeChipsContainer) {
            this.gradeChipsContainer.querySelectorAll('.filter-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    const grade = parseInt(chip.dataset.grade, 10);
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

        // Build category chips from loaded game data
        this.buildCategoryChips();
    }

    /**
     * Build primary and secondary category filter chips from game data
     */
    buildCategoryChips() {
        const primarySet = new Set();
        const secondarySet = new Set();

        this.allGames.forEach(game => {
            (game.primaryCategories || []).forEach(c => primarySet.add(c));
            (game.secondaryCategories || game.categories || []).forEach(c => secondarySet.add(c));
        });

        const createChips = (container, categories, selectedSet) => {
            if (!container) return;
            container.innerHTML = '';
            [...categories].sort().forEach(cat => {
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
        createChips(this.secondaryCategoryChipsContainer, secondarySet, this.selectedSecondaryCategories);
    }

    /**
     * Filter games based on search query, selected grades, and selected categories
     */
    filterGames() {
        this.filteredGames = this.allGames.filter(game => {
            // Search filter
            if (this.searchQuery) {
                const name = game.name.toLowerCase();
                const desc = (game.description || '').toLowerCase();
                if (!name.includes(this.searchQuery) && !desc.includes(this.searchQuery)) {
                    return false;
                }
            }

            // Grade filter - game must overlap with at least one selected grade
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

            // Primary category filter - game must have at least one selected primary category
            if (this.selectedPrimaryCategories.size > 0) {
                const gamePrimary = game.primaryCategories || [];
                if (!gamePrimary.some(c => this.selectedPrimaryCategories.has(c))) {
                    return false;
                }
            }

            // Secondary category filter - game must have at least one selected secondary category
            if (this.selectedSecondaryCategories.size > 0) {
                const gameSecondary = game.secondaryCategories || game.categories || [];
                if (!gameSecondary.some(c => this.selectedSecondaryCategories.has(c))) {
                    return false;
                }
            }

            return true;
        });
    }
    
    /**
     * Render the games grid
     */
    renderGamesGrid() {
        if (!this.gamesGrid) return;
        
        // Clear the grid
        this.gamesGrid.innerHTML = '';
        
        if (this.filteredGames.length === 0) {
            this.renderNoGamesMessage();
            return;
        }
        
        // Create game cards
        this.filteredGames.forEach(game => {
            const card = this.createGameCard(game);
            this.gamesGrid.appendChild(card);
        });
    }
    
    /**
     * Create a game card element
     * @param {Object} game - The game data
     * @returns {HTMLElement} - The game card element
     */
    createGameCard(game) {
        const card = document.createElement('div');
        card.classList.add('game-card');
        card.addEventListener('click', (e) => {
            // Don't navigate if clicking the details toggle
            if (e.target.closest('.game-card-details-toggle')) return;
            window.open(game.url, '_blank');
        });

        const cardImage = document.createElement('div');
        cardImage.classList.add('game-card-image');
        cardImage.style.backgroundImage = `url(${game.image})`;

        const cardContent = document.createElement('div');
        cardContent.classList.add('game-card-content');

        const title = document.createElement('h4');
        title.textContent = game.name;

        const chips = document.createElement('div');
        chips.classList.add('game-card-chips');

        // Primary categories (filled chips) - universal traits
        const primaryRow = document.createElement('div');
        primaryRow.classList.add('chip-row', 'chip-row-primary');
        const primaryCategories = game.primaryCategories || [];
        primaryCategories.forEach(cat => {
            const chip = document.createElement('span');
            chip.classList.add('chip', 'chip-primary');
            chip.textContent = cat;
            const colors = getCategoryChipColor(cat, true);
            chip.style.backgroundColor = colors.bg;
            chip.style.color = colors.textColor;
            primaryRow.appendChild(chip);
        });
        chips.appendChild(primaryRow);

        // Secondary categories (outlined chips) - gameplay styles
        const secondaryRow = document.createElement('div');
        secondaryRow.classList.add('chip-row', 'chip-row-secondary');
        const secondaryCategories = game.secondaryCategories || game.categories || [];
        secondaryCategories.forEach(cat => {
            const chip = document.createElement('span');
            chip.classList.add('chip', 'chip-secondary');
            chip.textContent = cat;
            const colors = getCategoryChipColor(cat, false);
            chip.style.borderColor = colors.bg;
            chip.style.color = colors.bg;
            secondaryRow.appendChild(chip);
        });
        chips.appendChild(secondaryRow);

        const gradeChip = document.createElement('span');
        gradeChip.classList.add('chip', 'chip-grade');
        const min = game.minGrade || 1;
        const max = game.maxGrade;
        gradeChip.textContent = min === max ? `GR ${min}` : `GR ${min}-${max}`;
        const colors = getGradeChipColor(max);
        gradeChip.style.backgroundColor = colors.bg;
        gradeChip.style.color = colors.textColor;
        // chips.appendChild(gradeChip);

        const detailsToggle = document.createElement('button');
        detailsToggle.classList.add('game-card-details-toggle');
        detailsToggle.innerHTML = '<i class="fas fa-chevron-down"></i> Details';
        detailsToggle.addEventListener('click', () => {
            card.classList.toggle('expanded');
        });

        const description = document.createElement('div');
        description.classList.add('game-card-description');
        const descText = document.createElement('p');
        descText.textContent = game.description;
        description.appendChild(descText);

        cardContent.appendChild(title);
        cardContent.appendChild(chips);
        cardContent.appendChild(detailsToggle);
        cardContent.appendChild(description);

        card.appendChild(cardImage);
        card.appendChild(cardContent);
        
        return card;
    }
    
    /**
     * Render a message when no games are available
     */
    renderNoGamesMessage() {
        const message = document.createElement('div');
        message.classList.add('no-games-message');
        message.innerHTML = `
            <i class="fas fa-exclamation-circle"></i>
            <h3>No Games Found</h3>
            <p>There are no games available for the selected grade level.</p>
        `;
        this.gamesGrid.appendChild(message);
    }
    
    /**
     * Handle errors
     */
    handleError() {
        if (this.gamesGrid) {
            this.gamesGrid.innerHTML = `
                <div class="error-message">
                    <i class="fas fa-exclamation-triangle"></i>
                    <h3>Error Loading Games</h3>
                    <p>There was a problem loading the games. Please try again later.</p>
                </div>
            `;
        }
        
        if (document.getElementById('trending-carousel')) {
            document.getElementById('trending-carousel').innerHTML = `
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

// Initialize games manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Only initialize on the games page
    if (document.getElementById('games-grid')) {
        new GamesManager();
    }
});
