const INVENTORY_SERIAL_QUERY_KEYS = new Set(['serial', 'servicetag', 'tag'])

export function normalizeInventorySerial(value: unknown): string {
	return String(value ?? '').trim().toUpperCase()
}

export function getInventorySerialFromSearch(search: string): string {
	const params = new URLSearchParams(search)

	for (const [key, value] of params) {
		if (INVENTORY_SERIAL_QUERY_KEYS.has(key.toLowerCase()) && value.trim()) {
			return normalizeInventorySerial(value)
		}
	}

	return ''
}

export function extractInventorySerial(value: unknown): string {
	const text = String(value ?? '').trim()
	if (!text) return ''

	try {
		const url = new URL(text, 'https://inventory.invalid')
		const serialFromUrl = getInventorySerialFromSearch(url.search)
		if (serialFromUrl) return serialFromUrl
	} catch {
		// Fall through to support plain serial text and scanner prefixes.
	}

	return normalizeInventorySerial(
		text.replace(/^serial\s*[:#-]?\s*/i, ''),
	)
}
