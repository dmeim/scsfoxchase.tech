export interface Game {
  id: string;
  name: string;
  url: string;
  image: string;
  thumbnail?: string;
  description: string;
  minGrade: number;
  maxGrade: number;
  primaryCategories?: string[];
  secondaryCategories?: string[];
  categories?: string[];
}

/**
 * Carousel for trending games — ported from js/carousel.js
 */
export class Carousel {
  track: HTMLElement | null;
  slides: HTMLElement[] = [];
  currentIndex = 0;
  slideWidth = 100;
  autoPlayInterval: ReturnType<typeof setInterval> | null = null;
  autoPlayDelay = 3000;
  container: Element | null = null;
  navContainer: Element | null = null;
  prevButton: Element | null = null;
  nextButton: Element | null = null;

  constructor(carouselId: string) {
    this.track = document.getElementById(carouselId);
    if (!this.track) return;

    this.container = this.track.closest('.carousel-container');
    this.navContainer = this.container?.querySelector('.carousel-nav') ?? null;
    this.prevButton = this.container?.querySelector('.carousel-button.prev') ?? null;
    this.nextButton = this.container?.querySelector('.carousel-button.next') ?? null;
    this.bindEvents();
  }

  init(items: Game[]) {
    if (!this.track || !this.navContainer) return;

    this.track.innerHTML = '';
    this.slides = [];
    this.currentIndex = 0;

    if (!items || items.length === 0) {
      this.track.innerHTML =
        '<li class="carousel-slide"><div class="carousel-slide-inner"><div class="carousel-slide-content"><h4>No Trending Games</h4><p>Check back later for trending games.</p></div></div></li>';
      return;
    }

    items.forEach((item, index) => {
      const slide = this.createSlide(item);
      this.track!.appendChild(slide);
      this.slides.push(slide);

      const indicator = this.navContainer.querySelectorAll<HTMLButtonElement>('[data-ui-progress-tab]')[index];
      indicator?.addEventListener('click', () => {
        this.goToSlide(index);
        this.resetAutoPlay();
      });
    });

    this.updateCarousel();
    this.startAutoPlay();
  }

  createSlide(item: Game): HTMLElement {
    const slide = document.createElement('li');
    slide.classList.add('carousel-slide');

    const link = document.createElement('a');
    link.classList.add('carousel-slide-link');
    link.href = item.url;
    link.target = '_blank';

    const slideBg = document.createElement('img');
    slideBg.classList.add('carousel-slide-bg');
    slideBg.src = item.image;
    slideBg.alt = '';
    slideBg.loading = 'lazy';
    slideBg.decoding = 'async';

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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        this.prevSlide();
        this.resetAutoPlay();
      } else if (e.key === 'ArrowRight') {
        this.nextSlide();
        this.resetAutoPlay();
      }
    });

    if (!this.track) return;

    let touchStartX = 0;
    let touchEndX = 0;

    this.track.addEventListener(
      'touchstart',
      (e) => {
        touchStartX = e.changedTouches[0].screenX;
      },
      { passive: true },
    );

    this.track.addEventListener(
      'touchend',
      (e) => {
        touchEndX = e.changedTouches[0].screenX;
        this.handleSwipe(touchStartX, touchEndX);
        this.resetAutoPlay();
      },
      { passive: true },
    );
  }

  handleSwipe(startX: number, endX: number) {
    const threshold = 50;
    const diff = startX - endX;

    if (Math.abs(diff) >= threshold) {
      if (diff > 0) {
        this.nextSlide();
      } else {
        this.prevSlide();
      }
    }
  }

  prevSlide() {
    if (this.slides.length <= 1) return;
    this.currentIndex--;
    if (this.currentIndex < 0) {
      this.currentIndex = this.slides.length - 1;
    }
    this.updateCarousel();
  }

  nextSlide() {
    if (this.slides.length <= 1) return;
    this.currentIndex++;
    if (this.currentIndex >= this.slides.length) {
      this.currentIndex = 0;
    }
    this.updateCarousel();
  }

  goToSlide(index: number) {
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

  updateCarousel() {
    if (!this.track || !this.navContainer) return;
    const position = -this.currentIndex * this.slideWidth;
    this.track.style.transform = `translateX(${position}%)`;

    const indicators = this.navContainer.querySelectorAll('.carousel-indicator');
    indicators.forEach((indicator, index) => {
      const active = index === this.currentIndex;
      indicator.classList.toggle('active', active);
      indicator.classList.toggle('is-active', active);
      indicator.setAttribute('aria-selected', String(active));
      (indicator as HTMLElement).tabIndex = active ? 0 : -1;
    });
  }
}
