import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const gamesStyles = readFileSync(
	fileURLToPath(new URL('../src/styles/newgames.css', import.meta.url)),
	'utf8',
)

describe('games catalog layout', () => {
	it('places the first-party launcher between the trending carousel and external games', () => {
		const catalog = readFileSync(
			fileURLToPath(new URL('../src/components/NewGamesCatalog.astro', import.meta.url)),
			'utf8',
		)
		expect(catalog.indexOf('data-ng-hero aria-label')).toBeLessThan(catalog.indexOf('<MiniGamesLauncher />'))
		expect(catalog.indexOf('<MiniGamesLauncher />')).toBeLessThan(catalog.indexOf('id="games-grid"'))
	})
	it('keeps the sticky filter card below the site header', () => {
		expect(gamesStyles).toMatch(/--newgames-header-height:\s*62px/)
		expect(gamesStyles).toMatch(
			/top:\s*calc\(var\(--newgames-header-height\) \+ var\(--newgames-sticky-gap\)\)/,
		)
		expect(gamesStyles).toMatch(
			/max-height:\s*calc\(100dvh - var\(--newgames-header-height\) - var\(--newgames-sticky-gap\) - var\(--newgames-sticky-gap\)\)/,
		)
	})
})
