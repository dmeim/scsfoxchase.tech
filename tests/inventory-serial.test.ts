import { describe, expect, it } from 'vitest'
import {
	extractInventorySerial,
	getInventorySerialFromSearch,
	normalizeInventorySerial,
} from '../src/lib/inventory-serial'

describe('inventory serial input', () => {
	it('normalizes a plain serial number', () => {
		expect(normalizeInventorySerial(' abc123xyz ')).toBe('ABC123XYZ')
		expect(extractInventorySerial('serial: abc123xyz')).toBe('ABC123XYZ')
	})

	it('extracts a serial from the printed inventory URL', () => {
		expect(
			extractInventorySerial(
				'https://scsfoxchase.tech/inventory?serial=ABC123XYZ',
			),
		).toBe('ABC123XYZ')
	})

	it('accepts a URL uppercased by a keyboard-style scanner', () => {
		expect(
			extractInventorySerial(
				'HTTPS://SCSFOXCHASE.TECH/INVENTORY?SERIAL=ABC123XYZ',
			),
		).toBe('ABC123XYZ')
	})

	it('accepts supported query aliases and relative inventory URLs', () => {
		expect(
			extractInventorySerial('/inventory?serviceTag=tag-123'),
		).toBe('TAG-123')
		expect(extractInventorySerial('?TAG=device_42')).toBe('DEVICE_42')
	})

	it('reads query parameter names case-insensitively', () => {
		expect(getInventorySerialFromSearch('?SERIAL=abc123')).toBe('ABC123')
		expect(getInventorySerialFromSearch('?other=x&ServiceTag=tag123')).toBe(
			'TAG123',
		)
	})

	it('ignores blank supported parameters in favor of a populated alias', () => {
		expect(getInventorySerialFromSearch('?serial=&tag=abc123')).toBe('ABC123')
	})
})
