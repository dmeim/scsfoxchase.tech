/**
 * Placeholder Images Generator
 * 
 * This script dynamically generates colored placeholder images for games
 * when actual image files are not available, and also creates PWA icons dynamically.
 */

// Generate a consistent color from a game ID string
function getColorForGameId(gameId) {
    let hash = 0;
    for (let i = 0; i < gameId.length; i++) {
        hash = gameId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 45%)`;
}

/**
 * Handles image loading errors by replacing with a colored placeholder
 * @param {Event} event - The error event
 */
function handleImageError(event) {
    const img = event.target;
    const gameId = getGameIdFromImagePath(img.src);
    
    if (gameId) {
        // Get color from map or use a default color
        const color = getColorForGameId(gameId);
        
        // Create a canvas element
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set canvas dimensions to match the image
        canvas.width = img.width || 300;
        canvas.height = img.height || 200;
        
        // Fill background
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Add game name text
        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Format game name from ID (e.g., "math-quest" -> "Math Quest")
        const gameName = gameId
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        
        ctx.fillText(gameName, canvas.width / 2, canvas.height / 2);
        
        // Replace the image source with the canvas data URL
        img.src = canvas.toDataURL('image/png');
    }
}

/**
 * Extracts the game ID from an image path
 * @param {string} path - The image path
 * @returns {string|null} - The game ID or null if not found
 */
function getGameIdFromImagePath(path) {
    // Extract filename from path
    const filename = path.split('/').pop();
    
    // Extract game ID from filename (remove extension)
    const gameId = filename.split('.')[0];
    
    return gameId || null;
}

/**
 * Initialize placeholder images handling
 */
function initPlaceholderImages() {
    // Add error handler to all images with paths containing "/images/"
    document.querySelectorAll('img[src*="/images/"]').forEach(img => {
        img.addEventListener('error', handleImageError);
    });
    
    // For background images in CSS (carousel slides and game cards)
    document.querySelectorAll('.carousel-slide-image, .game-card-image').forEach(element => {
        // Get the background image URL from inline style
        const style = element.style.backgroundImage;
        if (style && style.includes('/images/')) {
            // Extract the URL
            const url = style.replace(/^url\(['"](.+)['"]\)$/, '$1');
            
            // Create a test image to check if the file exists
            const testImg = new Image();
            testImg.onload = () => {
                // Image exists, do nothing
            };
            testImg.onerror = () => {
                // Image doesn't exist, create placeholder
                const gameId = getGameIdFromImagePath(url);
                if (gameId) {
                    const color = getColorForGameId(gameId);
                    element.style.backgroundColor = color;
                    
                    // Add game name as text content
                    const gameName = gameId
                        .split('-')
                        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(' ');
                    
                    // Only add text if it doesn't already have content
                    if (!element.querySelector('.placeholder-text')) {
                        const textElement = document.createElement('div');
                        textElement.classList.add('placeholder-text');
                        textElement.textContent = gameName;
                        textElement.style.color = 'white';
                        textElement.style.fontWeight = 'bold';
                        textElement.style.fontSize = '24px';
                        textElement.style.display = 'flex';
                        textElement.style.alignItems = 'center';
                        textElement.style.justifyContent = 'center';
                        textElement.style.height = '100%';
                        textElement.style.padding = '20px';
                        textElement.style.textAlign = 'center';
                        
                        element.appendChild(textElement);
                    }
                }
            };
            testImg.src = url;
        }
    });
}

/**
 * Generate PWA icons dynamically
 */
function generatePWAIcons() {
    // Create link elements for the icons
    const iconSizes = [192, 512];
    
    iconSizes.forEach(size => {
        // Check if icon link already exists
        const existingLink = document.querySelector(`link[rel="icon"][sizes="${size}x${size}"]`);
        if (existingLink) return;
        
        // Create canvas for the icon
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Set canvas size
        canvas.width = size;
        canvas.height = size;
        
        // Draw background
        ctx.fillStyle = '#4a6baf';
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, size * 0.2);
        ctx.fill();
        
        // Draw concentric circles
        const center = size / 2;
        const radiusSizes = [0.7, 0.58, 0.47];
        
        radiusSizes.forEach((radiusRatio, index) => {
            ctx.fillStyle = `rgba(255, 255, 255, ${0.1 * (index + 1)})`;
            ctx.beginPath();
            ctx.arc(center, center, center * radiusRatio, 0, Math.PI * 2);
            ctx.fill();
        });
        
        // Draw game controller icon
        ctx.fillStyle = '#ffffff';
        const controllerSize = size * 0.5;
        const controllerX = center - controllerSize / 2;
        const controllerY = center - controllerSize / 2;
        
        // Controller body
        ctx.beginPath();
        ctx.roundRect(
            controllerX, 
            controllerY + controllerSize * 0.3, 
            controllerSize, 
            controllerSize * 0.4, 
            controllerSize * 0.1
        );
        ctx.fill();
        
        // D-pad
        ctx.fillStyle = '#4a6baf';
        const dpadSize = controllerSize * 0.1;
        const dpadX = controllerX + controllerSize * 0.2;
        const dpadY = controllerY + controllerSize * 0.5;
        
        // Horizontal line
        ctx.beginPath();
        ctx.roundRect(
            dpadX - dpadSize, 
            dpadY - dpadSize / 3, 
            dpadSize * 2, 
            dpadSize * 2/3, 
            dpadSize * 0.3
        );
        ctx.fill();
        
        // Vertical line
        ctx.beginPath();
        ctx.roundRect(
            dpadX - dpadSize / 3, 
            dpadY - dpadSize, 
            dpadSize * 2/3, 
            dpadSize * 2, 
            dpadSize * 0.3
        );
        ctx.fill();
        
        // Buttons
        const buttonSize = controllerSize * 0.1;
        const buttonX1 = controllerX + controllerSize * 0.7;
        const buttonX2 = controllerX + controllerSize * 0.85;
        const buttonY = controllerY + controllerSize * 0.5;
        
        ctx.beginPath();
        ctx.arc(buttonX1, buttonY, buttonSize, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(buttonX2, buttonY, buttonSize, 0, Math.PI * 2);
        ctx.fill();
        
        // Add text if large enough
        if (size >= 192) {
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${size * 0.08}px Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SchoolTech', center, center + controllerSize * 0.4);
        }
        
        // Create link element
        const link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/png';
        link.sizes = `${size}x${size}`;
        link.href = canvas.toDataURL('image/png');
        
        // Add to head
        document.head.appendChild(link);
        
        // Also add as apple-touch-icon if it's the 192px version
        if (size === 192) {
            const appleLink = document.createElement('link');
            appleLink.rel = 'apple-touch-icon';
            appleLink.href = canvas.toDataURL('image/png');
            document.head.appendChild(appleLink);
        }
    });
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    initPlaceholderImages();
    generatePWAIcons();
});
