/**
 * Carousel Component
 * Handles the functionality of the trending games carousel
 */
class Carousel {
    constructor(carouselId) {
        // Get carousel elements
        this.track = document.getElementById(carouselId);
        if (!this.track) return;
        
        this.slides = [];
        this.currentIndex = 0;
        this.slideWidth = 100; // 100% width
        this.autoPlayInterval = null;
        this.autoPlayDelay = 3000;
        
        // Get parent elements
        this.container = this.track.closest('.carousel-container');
        this.navContainer = this.container.querySelector('.carousel-nav');
        
        // Get control buttons
        this.prevButton = this.container.querySelector('.carousel-button.prev');
        this.nextButton = this.container.querySelector('.carousel-button.next');
        
        // Initialize
        this.bindEvents();
    }
    
    /**
     * Initialize the carousel with slides
     * @param {Array} items - Array of items to create slides for
     */
    init(items) {
        // Clear any existing slides
        this.track.innerHTML = '';
        this.slides = [];
        this.navContainer.innerHTML = '';
        this.currentIndex = 0;
        
        if (!items || items.length === 0) {
            this.track.innerHTML = '<li class="carousel-slide"><div class="carousel-slide-inner"><div class="carousel-slide-content"><h4>No Trending Games</h4><p>Check back later for trending games.</p></div></div></li>';
            return;
        }
        
        // Create slides
        items.forEach((item, index) => {
            const slide = this.createSlide(item);
            this.track.appendChild(slide);
            this.slides.push(slide);
            
            // Create indicator
            const indicator = document.createElement('div');
            indicator.classList.add('carousel-indicator');
            if (index === 0) indicator.classList.add('active');
            indicator.dataset.index = index;
            this.navContainer.appendChild(indicator);
            
            // Add click event to indicator
            indicator.addEventListener('click', () => {
                this.goToSlide(index);
                this.resetAutoPlay();
            });
        });
        
        // Set initial position
        this.updateCarousel();
        this.startAutoPlay();
    }
    
    /**
     * Create a slide element for the carousel
     * @param {Object} item - The item data for the slide
     * @returns {HTMLElement} - The slide element
     */
    createSlide(item) {
        const slide = document.createElement('li');
        slide.classList.add('carousel-slide');

        const link = document.createElement('a');
        link.classList.add('carousel-slide-link');
        link.href = item.url;
        link.target = '_blank';

        const slideBg = document.createElement('div');
        slideBg.classList.add('carousel-slide-bg');
        slideBg.style.backgroundImage = `url(${item.image})`;

        const slideContent = document.createElement('div');
        slideContent.classList.add('carousel-slide-content');

        const title = document.createElement('h4');
        title.textContent = item.name;

        const description = document.createElement('p');
        description.textContent = item.description;

        slideContent.appendChild(title);
        slideContent.appendChild(description);

        link.appendChild(slideBg);
        link.appendChild(slideContent);
        slide.appendChild(link);

        return slide;
    }
    
    /**
     * Bind event listeners to carousel controls
     */
    bindEvents() {
        if (this.prevButton) {
            this.prevButton.addEventListener('click', () => {
                this.prevSlide();
                this.resetAutoPlay();
            });
        }

        if (this.nextButton) {
            this.nextButton.addEventListener('click', () => {
                this.nextSlide();
                this.resetAutoPlay();
            });
        }

        // Add keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') {
                this.prevSlide();
                this.resetAutoPlay();
            } else if (e.key === 'ArrowRight') {
                this.nextSlide();
                this.resetAutoPlay();
            }
        });
        
        // Add touch support
        let touchStartX = 0;
        let touchEndX = 0;
        
        this.track.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });
        
        this.track.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            this.handleSwipe(touchStartX, touchEndX);
            this.resetAutoPlay();
        }, { passive: true });
    }
    
    /**
     * Handle swipe gestures
     * @param {number} startX - Starting X position
     * @param {number} endX - Ending X position
     */
    handleSwipe(startX, endX) {
        const threshold = 50; // Minimum distance for swipe
        const diff = startX - endX;
        
        if (Math.abs(diff) >= threshold) {
            if (diff > 0) {
                // Swipe left, go to next slide
                this.nextSlide();
            } else {
                // Swipe right, go to previous slide
                this.prevSlide();
            }
        }
    }
    
    /**
     * Go to the previous slide
     */
    prevSlide() {
        if (this.slides.length <= 1) return;
        
        this.currentIndex--;
        if (this.currentIndex < 0) {
            this.currentIndex = this.slides.length - 1;
        }
        
        this.updateCarousel();
    }
    
    /**
     * Go to the next slide
     */
    nextSlide() {
        if (this.slides.length <= 1) return;
        
        this.currentIndex++;
        if (this.currentIndex >= this.slides.length) {
            this.currentIndex = 0;
        }
        
        this.updateCarousel();
    }
    
    /**
     * Go to a specific slide
     * @param {number} index - The index of the slide to go to
     */
    goToSlide(index) {
        if (index < 0 || index >= this.slides.length) return;
        
        this.currentIndex = index;
        this.updateCarousel();
    }
    
    startAutoPlay() {
        this.stopAutoPlay();
        if (this.slides.length <= 1) return;
        this.autoPlayInterval = setInterval(() => this.nextSlide(), this.autoPlayDelay);
    }

    stopAutoPlay() {
        if (this.autoPlayInterval) {
            clearInterval(this.autoPlayInterval);
            this.autoPlayInterval = null;
        }
    }

    resetAutoPlay() {
        this.startAutoPlay();
    }

    /**
     * Update the carousel position and indicators
     */
    updateCarousel() {
        // Update track position
        const position = -this.currentIndex * this.slideWidth;
        this.track.style.transform = `translateX(${position}%)`;
        
        // Update indicators
        const indicators = this.navContainer.querySelectorAll('.carousel-indicator');
        indicators.forEach((indicator, index) => {
            if (index === this.currentIndex) {
                indicator.classList.add('active');
            } else {
                indicator.classList.remove('active');
            }
        });
    }
}

// Initialize carousel when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // The carousel will be initialized by games.js after data is loaded
});
