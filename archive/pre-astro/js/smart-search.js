document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-smart-search]').forEach((form) => {
        const toggle = form.querySelector('.smart-search-toggle');
        const menu = form.querySelector('.smart-search-menu');
        const label = form.querySelector('.smart-search-label');
        const icon = form.querySelector('.smart-search-icon');
        const input = form.querySelector('.smart-search-input');
        const options = form.querySelectorAll('.smart-search-option');
        let currentUrl = form.querySelector('.smart-search-option.active')?.dataset.url || '';

        const closeMenu = () => {
            menu.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        };

        const positionMenu = () => {
            const rect = toggle.getBoundingClientRect();
            menu.style.top = `${rect.bottom + 8}px`;
            menu.style.left = `${rect.left}px`;
        };

        toggle.addEventListener('click', () => {
            const willOpen = !menu.classList.contains('open');
            if (willOpen) positionMenu();
            menu.classList.toggle('open', willOpen);
            toggle.setAttribute('aria-expanded', String(willOpen));
        });

        window.addEventListener('resize', () => {
            if (menu.classList.contains('open')) positionMenu();
        });

        window.addEventListener('scroll', () => {
            if (menu.classList.contains('open')) positionMenu();
        }, true);

        options.forEach((option) => {
            option.addEventListener('click', () => {
                options.forEach((item) => item.classList.remove('active'));
                option.classList.add('active');
                currentUrl = option.dataset.url;
                label.textContent = option.dataset.label;
                icon.src = option.dataset.icon;
                input.placeholder = option.dataset.placeholder;
                closeMenu();
                input.focus();
            });
        });

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const query = input.value.trim();
            if (!query || !currentUrl) {
                input.focus();
                return;
            }
            window.open(currentUrl.replace('{query}', encodeURIComponent(query)), '_blank', 'noopener,noreferrer');
        });

        document.addEventListener('click', (event) => {
            if (!form.contains(event.target)) closeMenu();
        });
    });
});
