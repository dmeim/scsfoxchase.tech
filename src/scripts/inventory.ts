// Inventory lookup page (Astro ESM port)
import { iconSearch } from './icons';
import { setUiButtonLoading, uiClassNames } from '../components/ui/dom';
import {
    extractInventorySerial,
    getInventorySerialFromSearch,
} from '../lib/inventory-serial';
declare global {
  interface Window {
    jsQR?: (
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options?: { inversionAttempts?: string },
    ) => { data: string } | null;
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
    };
  }
}

const ASSET_LOOKUP_ENDPOINT = '/api/forms/inventory';
const FORM_CONFIG_ENDPOINT = '/api/forms/config';
const TURNSTILE_ACTION = 'inventory_lookup';
const REQUEST_SERIAL_FIELD = 'serial';
const NO_DATA_LABEL = 'No Data';
const NOT_APPLICABLE_LABEL = 'Does Not Apply';

const FALLBACK_DEVICE_IMAGE = '/images/inventory/fallback-device.svg';
const MODEL_IMAGES = {
    'ipad a2602': '/images/ipad-A2602.jpg',
    'dell chromebook 3100': '/images/dell-chromebook-3100-1.jpg',
    'samsung 310xba': '/images/samsung-310XBA.jpg',
    'lenovo 14e gen 3': '/images/lenovo-14e-gen-3.jpeg'
};

const FIELD_ALIASES = {
    deviceStatus: ['Device Status', 'Overall Status', 'Status'],
    assignedTo: ['Assigned To', 'Assigned', 'Assignee', 'User'],
    deviceNumber: ['Device Number', 'Asset Number', 'Device #'],
    serial: ['Serial Number / Service Tag', 'Serial Number', 'Service Tag', 'Serial', 'ServiceTag'],
    expressServiceCode: ['Express Service Code', 'Express Code'],
    makeModel: ['Make / Model', 'Make/Model', 'Model', 'Device Model'],
    yearPurchased: ['Year Purchased', 'Purchase Year', 'Year'],
    grant: ['Grant'],
    notes: ['Notes', 'Note', 'Repair Notes']
};

const COMPONENT_FIELDS = [
    { label: 'Case', keys: ['Case'] },
    { label: 'Chassis', keys: ['Chassis'] },
    { label: 'Hinges', keys: ['Hinges', 'Hinge'] },
    { label: 'Display', keys: ['Display', 'Screen'] },
    { label: 'Keyboard / Buttons', keys: ['Keyboard / Buttons', 'Keyboard'] },
    { label: 'Trackpad / Mouse', keys: ['Trackpad / Mouse', 'Trackpad', 'Touchpad', 'Mouse'] },
    { label: 'Battery / Charging', keys: ['Battery / Charging', 'Battery', 'Charging'] },
    { label: 'Ports', keys: ['Ports', 'Port'] },
    { label: 'Camera / Audio', keys: ['Camera / Audio', 'Camera', 'Audio'] }
];

// Exact colors from the Google Sheet data-validation dropdowns.
const PART_STATUS_COLORS = {
    'Unknown': { bg: '#EADCF8', text: '#4A148C' },
    'N/A': { bg: '#E0E0E0', text: '#424242' },
    'Ok': { bg: '#D9EAD3', text: '#274E13' },
    'Cosmetic': { bg: '#D9EAF7', text: '#0B5394' },
    'Loose': { bg: '#FFF2CC', text: '#7F6000' },
    'Missing': { bg: '#FCE5CD', text: '#783F04' },
    'Damaged': { bg: '#F4CCCC', text: '#990000' },
    'Not Working': { bg: '#E06666', text: '#FFFFFF' }
};

const DEVICE_STATUS_COLORS = {
    'Unknown': { bg: '#EADCF8', text: '#4A148C' },
    'Ok': { bg: '#D9EAD3', text: '#274E13' },
    'No DRC': { bg: '#D9EAF7', text: '#0B5394' },
    'Repair': { bg: '#F4CCCC', text: '#990000' },
    'Warranty': { bg: '#FFF2CC', text: '#7F6000' },
    'Parts Only': { bg: '#D9D2E9', text: '#351C75' },
    'Missing': { bg: '#FCE5CD', text: '#783F04' },
    'Lost': { bg: '#E06666', text: '#FFFFFF' },
    'Retired': { bg: '#D9D9D9', text: '#434343' }
};

const state = {
    form: null,
    input: null,
    button: null,
    scanButton: null,
    printButton: null,
    result: null,
    message: null,
    configNotice: null,
    scannerModal: null,
    scannerVideo: null,
    scannerCanvas: null,
    scannerStatus: null,
    scannerClose: null,
    scannerCancel: null,
    scannerStream: null,
    scannerFrameRequest: null,
    scannerActive: false,
    turnstileContainer: null,
    turnstileScript: null,
    turnstileWidgetId: null,
    turnstileToken: '',
    turnstileUnavailable: false,
    pendingAutoLookup: false,
    lookupActive: false
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
    state.form = document.getElementById('assetLookupForm');
    state.input = document.getElementById('assetSerialInput');
    state.button = document.getElementById('assetLookupButton');
    state.scanButton = document.getElementById('assetScanButton');
    state.printButton = document.getElementById('assetPrintButton');
    state.result = document.getElementById('assetResult');
    state.message = document.getElementById('assetMessage');
    state.configNotice = document.getElementById('assetConfigNotice');
    state.scannerModal = document.getElementById('assetScannerModal');
    state.scannerVideo = document.getElementById('assetScannerVideo');
    state.scannerCanvas = document.getElementById('assetScannerCanvas');
    state.scannerStatus = document.getElementById('assetScannerStatus');
    state.scannerClose = document.getElementById('assetScannerClose');
    state.scannerCancel = document.getElementById('assetScannerCancel');
    state.turnstileContainer = document.getElementById('assetTurnstile');
    state.turnstileScript = document.getElementById('inventoryTurnstileScript');

    if (!state.form || !state.input || !state.result || !state.message) return;

    if (state.button) state.button.disabled = true;

    state.form.addEventListener('submit', event => {
        event.preventDefault();
        lookupFromInput();
    });

    state.input.addEventListener('input', () => {
        state.input.value = state.input.value.toUpperCase();
    });

    state.printButton?.addEventListener('click', printReport);

    setupScannerControls();
    setupTurnstile();

    const serialFromUrl = getSerialFromUrl();
    if (serialFromUrl) {
        state.input.value = serialFromUrl;
        state.pendingAutoLookup = true;
        maybeRunPendingLookup();
    } else {
        state.input.focus();
    }
}

class InventoryLookupError extends Error {}

async function setupTurnstile() {
    const container = state.turnstileContainer;
    if (!container) {
        markTurnstileUnavailable();
        return;
    }

    state.turnstileScript?.addEventListener('error', markTurnstileUnavailable, { once: true });

    let sitekey = '';
    try {
        const response = await fetch(FORM_CONFIG_ENDPOINT, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store'
        });
        const contentType = response.headers.get('Content-Type') || '';
        if (!response.ok || !contentType.toLowerCase().includes('application/json')) {
            throw new Error('form-config-unavailable');
        }
        const config = await response.json();
        sitekey = typeof config?.turnstileSitekey === 'string'
            ? config.turnstileSitekey.trim()
            : '';
        if (!sitekey || sitekey.length > 256) {
            throw new Error('form-config-invalid');
        }
    } catch {
        markTurnstileUnavailable();
        return;
    }

    if (state.turnstileUnavailable) return;

    const renderTimeout = window.setTimeout(() => {
        if (!state.turnstileWidgetId) markTurnstileUnavailable();
    }, 10_000);

    const render = () => {
        if (state.turnstileUnavailable || !window.turnstile || state.turnstileWidgetId) return;
        try {
            state.turnstileWidgetId = window.turnstile.render(container, {
                sitekey,
                action: TURNSTILE_ACTION,
                appearance: 'interaction-only',
                size: 'flexible',
                callback: token => {
                    state.turnstileToken = token;
                    if (state.button) state.button.disabled = false;
                    maybeRunPendingLookup();
                },
                'expired-callback': () => {
                    state.turnstileToken = '';
                    if (state.button) state.button.disabled = true;
                    resetTurnstile();
                },
                'error-callback': () => {
                    state.turnstileToken = '';
                    if (state.button) state.button.disabled = true;
                    showMessage('Security verification could not load. Refresh the page and try again.', 'error');
                },
                'timeout-callback': () => {
                    state.turnstileToken = '';
                    if (state.button) state.button.disabled = true;
                }
            });
            window.clearTimeout(renderTimeout);
        } catch {
            window.clearTimeout(renderTimeout);
            markTurnstileUnavailable();
        }
    };

    if (window.turnstile) {
        render();
    } else {
        state.turnstileScript?.addEventListener('load', render, { once: true });
    }
}

function markTurnstileUnavailable() {
    state.turnstileUnavailable = true;
    state.turnstileToken = '';
    if (state.button) state.button.disabled = true;
    if (state.configNotice) {
        state.configNotice.hidden = false;
        state.configNotice.textContent = 'Inventory lookup is temporarily unavailable because security verification is not configured.';
    }
}

function maybeRunPendingLookup() {
    if (!state.pendingAutoLookup || !state.turnstileToken) return;
    state.pendingAutoLookup = false;
    lookupFromInput({ updateUrl: false });
}

function resetTurnstile() {
    state.turnstileToken = '';
    if (state.button) state.button.disabled = true;
    if (window.turnstile && state.turnstileWidgetId) {
        window.turnstile.reset(state.turnstileWidgetId);
    }
}

async function lookupFromInput(options = {}) {
    if (state.lookupActive) return;
    const serial = extractInventorySerial(state.input.value);
    state.input.value = serial;

    if (!serial) {
        showMessage('Enter a serial number or service tag to look up a device.', 'error');
        state.input.focus();
        return;
    }
    if (state.turnstileUnavailable) return;
    if (!state.turnstileToken) {
        showMessage('Security verification is still loading. Wait a moment and try again.', 'error');
        return;
    }

    const turnstileToken = state.turnstileToken;
    state.turnstileToken = '';
    state.lookupActive = true;

    setLoading(true, `Looking up ${serial}...`);
    clearResult();

    try {
        const responsePayload = await fetchAsset(serial, turnstileToken);
        const asset = normalizeLookupResponse(responsePayload);

        if (!asset) {
            showMessage(`No device found for ${serial}. Check the serial number and try again.`, 'error');
            updateUrlSerial(serial, options.updateUrl !== false);
            return;
        }

        renderAsset(asset, serial);
        hideMessage();
        updateUrlSerial(getField(asset, FIELD_ALIASES.serial, serial), options.updateUrl !== false);
    } catch (error) {
        console.error('Asset lookup failed.');
        showMessage(
            error instanceof InventoryLookupError
                ? error.message
                : 'The inventory service is temporarily unavailable. Try again.',
            'error'
        );
    } finally {
        state.lookupActive = false;
        setLoading(false);
        resetTurnstile();
    }
}

function setupScannerControls() {
    if (!state.scanButton || !state.scannerModal || !state.scannerVideo || !state.scannerCanvas) return;

    state.scanButton.addEventListener('click', startScanner);
    state.scannerClose?.addEventListener('click', () => stopScanner());
    state.scannerCancel?.addEventListener('click', () => stopScanner());

    state.scannerModal.addEventListener('click', event => {
        if (event.target === state.scannerModal) stopScanner();
    });
    state.scannerModal.addEventListener('close', () => {
        if (state.scannerActive || state.scannerStream) stopScanner();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.scannerActive) stopScanner();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && state.scannerActive) stopScanner({ hideMessageAfterStop: true });
    });
}

async function startScanner() {
    if (!navigator.mediaDevices?.getUserMedia) {
        showMessage('Camera scanning is not supported in this browser. You can still type or paste the serial number.', 'error');
        return;
    }

    if (typeof window.jsQR !== 'function') {
        showMessage('The QR scanner could not load. Refresh the page, or type the serial number manually.', 'error');
        return;
    }

    try {
        state.scannerModal.showModal();
        document.body.classList.add('asset-scanner-open');
        setScannerStatus('Camera starting...');
        state.scanButton.disabled = true;

        state.scannerStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });

        state.scannerVideo.srcObject = state.scannerStream;
        await state.scannerVideo.play();

        state.scannerActive = true;
        state.scanButton.disabled = false;
        setScannerStatus('Point the camera at the QR code. The serial will fill in after a scan.');
        state.scannerFrameRequest = window.requestAnimationFrame(scanQrFrame);
    } catch (error) {
        console.error('QR scanner failed to start:', error);
        state.scanButton.disabled = false;
        stopScanner({ hideMessageAfterStop: true });
        showMessage('Could not open the camera. Check camera permission for this site, then try again.', 'error');
    }
}

function scanQrFrame() {
    if (!state.scannerActive) return;

    const video = state.scannerVideo;
    const canvas = state.scannerCanvas;
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth && video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const qrCode = window.jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'attemptBoth'
        });

        if (qrCode?.data) {
            fillSerialFromQr(qrCode.data);
            return;
        }
    }

    state.scannerFrameRequest = window.requestAnimationFrame(scanQrFrame);
}

function fillSerialFromQr(rawQrValue) {
    const serial = extractSerialFromQr(rawQrValue);

    if (!serial) {
        setScannerStatus('QR code scanned, but no serial number was found. Try another tag.');
        state.scannerFrameRequest = window.requestAnimationFrame(scanQrFrame);
        return;
    }

    state.input.value = serial;
    stopScanner({ hideMessageAfterStop: true });
    lookupFromInput();
}

function extractSerialFromQr(rawQrValue) {
    return extractInventorySerial(rawQrValue);
}

function stopScanner(options = {}) {
    state.scannerActive = false;

    if (state.scannerFrameRequest) {
        window.cancelAnimationFrame(state.scannerFrameRequest);
        state.scannerFrameRequest = null;
    }

    if (state.scannerStream) {
        state.scannerStream.getTracks().forEach(track => track.stop());
        state.scannerStream = null;
    }

    if (state.scannerVideo) {
        state.scannerVideo.pause();
        state.scannerVideo.srcObject = null;
    }

    if (state.scannerModal?.open) {
        state.scannerModal.close();
    }

    if (state.scanButton) {
        state.scanButton.disabled = false;
    }

    document.body.classList.remove('asset-scanner-open');

    if (!options.hideMessageAfterStop) {
        hideMessage();
    }
}

function setScannerStatus(message) {
    if (state.scannerStatus) state.scannerStatus.textContent = message;
}

async function fetchAsset(serial, turnstileToken) {
    const response = await fetch(ASSET_LOOKUP_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            [REQUEST_SERIAL_FIELD]: serial,
            turnstileToken
        })
    });

    if (!response.ok) {
        if (response.status === 400) {
            throw new InventoryLookupError('Enter a valid serial number or service tag.');
        }
        if (response.status === 403) {
            throw new InventoryLookupError('Security verification failed. Refresh the page and try again.');
        }
        if (response.status === 429) {
            throw new InventoryLookupError('Too many lookups were submitted. Wait a minute and try again.');
        }
        throw new InventoryLookupError('The inventory service is temporarily unavailable. Try again.');
    }

    const text = await response.text();
    if (!text.trim()) return { found: false };

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error('Webhook did not return valid JSON.');
    }
}

function normalizeLookupResponse(payload) {
    if (!payload) return null;

    if (Array.isArray(payload)) {
        if (!payload.length) return null;
        return normalizeLookupResponse(payload[0]);
    }

    if (typeof payload !== 'object') return null;
    if (payload.found === false) return null;

    if (payload.asset && typeof payload.asset === 'object') return normalizeLookupResponse(payload.asset);
    if (payload.row && typeof payload.row === 'object') return normalizeLookupResponse(payload.row);
    if (payload.rows && typeof payload.rows === 'object') return normalizeLookupResponse(payload.rows);
    if (payload.result && typeof payload.result === 'object') return normalizeLookupResponse(payload.result);
    if (payload.results && typeof payload.results === 'object') return normalizeLookupResponse(payload.results);
    if (payload.items && typeof payload.items === 'object') return normalizeLookupResponse(payload.items);
    if (payload.data && typeof payload.data === 'object') return normalizeLookupResponse(payload.data);
    if (payload.json && typeof payload.json === 'object') return normalizeLookupResponse(payload.json);

    return payload;
}

function renderAsset(asset, fallbackSerial) {
    const deviceStatus = getField(asset, FIELD_ALIASES.deviceStatus, 'Unknown: Not Checked');
    const deviceNumber = getField(asset, FIELD_ALIASES.deviceNumber, 'Device');
    const serial = getField(asset, FIELD_ALIASES.serial, fallbackSerial);
    const makeModel = getField(asset, FIELD_ALIASES.makeModel, NO_DATA_LABEL);
    const image = getDeviceImage(makeModel);

    const details = [
        ['Assigned To', getField(asset, FIELD_ALIASES.assignedTo, NO_DATA_LABEL), 'wide'],
        ['Device Number', deviceNumber],
        ['Make / Model', makeModel],
        ['Serial / Service Tag', serial],
        ['Express Service Code', getField(asset, FIELD_ALIASES.expressServiceCode, NO_DATA_LABEL)],
        ['Year Purchased', getField(asset, FIELD_ALIASES.yearPurchased, NO_DATA_LABEL)],
        ['Grant', getField(asset, FIELD_ALIASES.grant, NO_DATA_LABEL)]
    ];

    const statusCard = `
        <div class="${uiClassNames.card('asset-condition-card asset-condition-card-wide asset-status-condition-card')}">
            <span class="asset-condition-name">Status</span>
            ${renderConditionStatuses(deviceStatus)}
        </div>
    `;

    const componentCards = COMPONENT_FIELDS
        .filter(component => component.label !== 'Buttons' || hasField(asset, component.keys))
        .map(component => {
            const value = getField(asset, component.keys, NO_DATA_LABEL);
            return `
                <div class="${uiClassNames.card('asset-condition-card')}">
                    <span class="asset-condition-name">${escapeHtml(component.label)}</span>
                    ${renderConditionStatuses(value)}
                </div>
            `;
        })
        .join('');

    const notes = getField(asset, FIELD_ALIASES.notes, NO_DATA_LABEL);
    const notesClass = isSpecialValue(notes) ? 'asset-notes asset-muted' : 'asset-notes';
    const notesToneAttribute = getSpecialToneAttribute(notes);

    state.result.innerHTML = `
        <div class="asset-print-header">
            <h1>St. Cecilia Inventory Report</h1>
            <p><span data-print-date>${escapeHtml(formatPrintedDate())}</span></p>
        </div>

        <article class="${uiClassNames.card('asset-card')}">
            <div class="asset-overview-grid">
                <div class="${uiClassNames.card('asset-photo-card')}">
                    <img class="asset-device-photo" data-asset-photo src="${escapeAttribute(image.src)}" alt="${escapeAttribute(image.alt)}">
                </div>
                <div class="asset-details-grid">
                    ${details.map(([label, value, layout]) => `
                        <div class="${uiClassNames.card(`asset-detail${layout === 'wide' ? ' asset-detail-wide' : ''}`)}">
                            <div class="asset-detail-label">${escapeHtml(label)}</div>
                            <div class="asset-detail-value"${getSpecialToneAttribute(value)}>${escapeHtml(value)}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        </article>

        <div class="asset-lower-grid">
            <section class="${uiClassNames.card('asset-section-card asset-device-condition-card')}" aria-labelledby="asset-condition-title">
                <div class="asset-section-title-row">
                    <div>
                        <h3 id="asset-condition-title" class="asset-section-title">Condition</h3>
                    </div>
                </div>
                <div class="asset-condition-grid">
                    ${statusCard}
                    ${componentCards}
                </div>
            </section>

            <section class="${uiClassNames.card('asset-section-card asset-notes-card')}" aria-labelledby="asset-notes-title">
                <div class="asset-section-title-row">
                    <div>
                        <h3 id="asset-notes-title" class="asset-section-title">Notes</h3>
                    </div>
                </div>
                <p class="${notesClass}"${notesToneAttribute}>${escapeHtml(notes)}</p>
            </section>
        </div>
    `;

    const photo = state.result.querySelector('[data-asset-photo]');
    if (photo) {
        photo.addEventListener('error', () => {
            photo.src = FALLBACK_DEVICE_IMAGE;
            photo.alt = 'Generic laptop illustration';
        }, { once: true });
    }

    state.result.hidden = false;
    setPrintEnabled(true);
}

function renderConditionStatuses(value) {
    const statuses = splitMultiValue(value);

    if (statuses.length <= 1) {
        const status = statuses[0] || NO_DATA_LABEL;
        const style = getExactStatusStyle(status);
        return `<span class="${uiClassNames.badge('normal', 'asset-condition-status')}" data-status-tone="${getStatusTone(status)}"${style ? ' ' + style : ''}>${escapeHtml(status)}</span>`;
    }

    return `
        <span class="asset-condition-status-list" aria-label="Multiple condition values">
            ${statuses.map(status => {
                const style = getExactStatusStyle(status);
                return `<span class="${uiClassNames.badge('normal', 'asset-condition-status')}" data-status-tone="${getStatusTone(status)}"${style ? ' ' + style : ''}>${escapeHtml(status)}</span>`;
            }).join('')}
        </span>
    `;
}

function splitMultiValue(value) {
    return String(value || '')
        .split(/[,;\n]+/)
        .map(part => formatAssetValue(part.trim()))
        .filter(Boolean);
}

function getDeviceImage(makeModel) {
    const normalized = normalizeText(makeModel);
    const mapped = MODEL_IMAGES[normalized];

    if (mapped) {
        return {
            src: mapped,
            alt: `${makeModel} image`,
            caption: makeModel
        };
    }

    if (makeModel && !isSpecialValue(makeModel)) {
        return {
            src: `/images/inventory/${slugify(makeModel)}.png`,
            alt: `${makeModel} image`,
            caption: makeModel
        };
    }

    return {
        src: FALLBACK_DEVICE_IMAGE,
        alt: 'Generic laptop illustration',
        caption: 'Generic device image'
    };
}

function getField(asset, keys, fallback = '') {
    const lookup = buildKeyLookup(asset);

    for (const key of keys) {
        const matchingKey = lookup[normalizeText(key)];
        if (!matchingKey) continue;

        const value = asset[matchingKey];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return formatAssetValue(String(value).trim());
        }
    }

    return fallback;
}

function hasField(asset, keys) {
    const lookup = buildKeyLookup(asset);
    return keys.some(key => Boolean(lookup[normalizeText(key)]));
}

function buildKeyLookup(asset) {
    return Object.keys(asset || {}).reduce((lookup, key) => {
        lookup[normalizeText(key)] = key;
        return lookup;
    }, {});
}

function getStatusTone(value) {
    if (findStatusColors(value)) return 'neutral'; // exact colors applied inline

    const status = normalizeText(value);

    if (isNoDataValue(value) || status.includes('not checked') || status.includes('unknown')) return 'nodata';
    if (isNotApplicableValue(value)) return 'notapplicable';
    if (status.includes('no warranty') || status.includes('dead') || status.includes('broken') || status.includes('cracked') || status.includes('damaged') || status.includes("won't charge") || status.includes('wont charge')) return 'danger';
    if (status.includes('repair') || status.includes('check warranty') || status.includes('in warranty') || status.includes('no drc') || status.includes('scratch') || status.includes('scratches') || status.includes('dented') || status.includes('chipped') || status.includes('loose') || status.includes('missing key') || status.includes('missing button')) return 'warning';
    if (status.includes('replaced') || status.includes('harvested')) return 'info';
    if (status.includes('lost') || status.includes('missing')) return 'muted';
    if (status.includes('ok') || status.includes('working') || status.includes('none applied')) return 'good';

    return 'neutral';
}

function findStatusColors(value) {
    const normalized = String(value || '').trim();
    return PART_STATUS_COLORS[normalized] || DEVICE_STATUS_COLORS[normalized] || null;
}

function getExactStatusStyle(value) {
    const colors = findStatusColors(value);
    if (!colors) return '';
    const border = `color-mix(in srgb, ${colors.bg} 80%, #000000)`;
    return `style="--tone-bg: ${colors.bg}; --tone-border: ${border}; --tone-text: ${colors.text};"`;
}

function printReport() {
    if (!state.result || state.result.hidden) {
        showMessage('Look up a device first, then print the report.', 'error');
        return;
    }

    const printedDate = state.result.querySelector('[data-print-date]');
    if (printedDate) printedDate.textContent = formatPrintedDate();

    window.print();
}

function setPrintEnabled(enabled) {
    if (state.printButton) state.printButton.disabled = !enabled;
}

function showMessage(text, tone = 'success') {
    state.message.className = uiClassNames.feedback(tone === 'error' ? 'error' : 'success', 'asset-message');
    state.message.innerHTML = escapeHtml(text);
    state.message.dataset.messageTone = tone;
    state.message.hidden = false;
}

function hideMessage() {
    state.message.innerHTML = '';
    state.message.hidden = true;
}

function setLoading(isLoading, text = '') {
    if (state.button) {
        setUiButtonLoading(state.button, isLoading, { loading: 'Looking up', idle: 'Lookup' }, iconSearch);
    }

    if (isLoading) {
        state.message.className = uiClassNames.feedback('loading', 'asset-message');
        state.message.innerHTML = `<span class="asset-loading-row"><span class="asset-loading-spinner" aria-hidden="true"></span>${escapeHtml(text)}</span>`;
        state.message.dataset.messageTone = 'loading';
        state.message.hidden = false;
    }
}

function clearResult() {
    state.result.innerHTML = '';
    state.result.hidden = true;
    setPrintEnabled(false);
}

function getSerialFromUrl() {
    return getInventorySerialFromSearch(window.location.search);
}

function updateUrlSerial(serial, shouldUpdate = true) {
    if (!shouldUpdate || !window.history || !serial) return;

    const url = new URL(window.location.href);
    url.searchParams.set('serial', serial);
    window.history.replaceState({}, '', url);
}

function formatPrintedDate() {
    return new Date().toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function normalizeText(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isNoDataValue(value) {
    const normalized = normalizeText(value);
    const stripped = normalized
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return !normalized ||
        normalized === normalizeText(NO_DATA_LABEL) ||
        stripped === 'no data' ||
        stripped === 'not recorded' ||
        stripped === 'no notes recorded';
}

function isNotApplicableValue(value) {
    const normalized = normalizeText(value);
    const stripped = normalized
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized === normalizeText(NOT_APPLICABLE_LABEL) ||
        stripped === 'n a' ||
        stripped === 'na' ||
        stripped === 'not applicable' ||
        stripped === 'does not apply' ||
        stripped === "doesn't apply";
}

function isSpecialValue(value) {
    return isNoDataValue(value) || isNotApplicableValue(value);
}

function formatAssetValue(value) {
    if (value === undefined || value === null || String(value).trim() === '') return NO_DATA_LABEL;
    return String(value).trim();
}

function getSpecialToneAttribute(value) {
    if (isNoDataValue(value)) return ' data-status-tone="nodata"';
    if (isNotApplicableValue(value)) return ' data-status-tone="notapplicable"';
    return '';
}

function slugify(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
}
