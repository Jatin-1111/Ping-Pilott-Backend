// utils/evidence.js - what the server actually said when a check failed: its status, a few of its headers, the address
// the name resolved to, and the first bit of the page
//
// It is what lets a person see "a maintenance page" or "a Cloudflare block page" without reproducing the failure. It is
// also somebody else's data stored in ours, so everything here is allow-listed and capped: only these headers, short
// values, text pages only, at most MAX_SNIPPET_BYTES of the page, and nothing that is not printable. It is only read for
// a check that failed (never for one that worked), kept as long as the check is, and shown to the server's owner only.
// A person's page can still contain something private; that is why the owner can turn the detail off by plan and why
// it is shown collapsed, as plain text.
//
// Pure functions except readSnippet, which only reads the stream it is given.

export const MAX_SNIPPET_BYTES = 1024;
export const MAX_HEADER_VALUE = 200;
const SNIPPET_READ_MS = 1500;

// Headers that say who answered and why, and nothing that identifies a person or a session (no cookies, no auth)
export const SAFE_HEADERS = [
    'server', 'content-type', 'content-length', 'content-encoding', 'location', 'retry-after', 'via', 'x-powered-by',
    'cf-ray', 'cf-cache-status', 'x-cache', 'x-served-by', 'x-vercel-id', 'x-amz-cf-pop', 'age', 'www-authenticate'
];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const asPlain = (headers) => {
    if (!headers || typeof headers !== 'object') return {};
    // axios hands back an AxiosHeaders, which can describe itself as a plain object
    return typeof headers.toJSON === 'function' ? headers.toJSON() : headers;
};

const oneLine = (value) => String(value).replace(CONTROL, '').replace(/\s+/g, ' ').trim();

/** The headers worth keeping, lower-cased, each short. A redirect target keeps its path, not its query (it can carry a token). */
export function safeHeaders(headers) {
    const plain = asPlain(headers);
    const kept = {};
    for (const [name, raw] of Object.entries(plain)) {
        const key = String(name).toLowerCase();
        if (!SAFE_HEADERS.includes(key) || raw === undefined || raw === null) continue;
        let value = oneLine(Array.isArray(raw) ? raw.join(', ') : raw);
        if (key === 'location') value = value.replace(/[?#].*$/, '');
        if (!value) continue;
        kept[key] = value.length > MAX_HEADER_VALUE ? `${value.slice(0, MAX_HEADER_VALUE)}…` : value;
    }
    return kept;
}

/** Is this a page worth quoting? Text, JSON, XML. An unknown type is tried, and refused later if it holds binary. */
export const isTextual = (contentType) => {
    if (!contentType) return true;
    return /^(text\/|application\/(json|xml|xhtml\+xml|javascript|problem\+json)|[^;]*\+(json|xml))/i.test(String(contentType).trim());
};

/**
 * The first bit of a page as text, or null when there is nothing safe to quote.
 * @param {Buffer|Uint8Array|string|null|undefined} body
 * @returns {{ text: string, truncated: boolean }|null}
 */
export function snippetOf(body, { contentType, wasCut = false } = {}) {
    if (body === undefined || body === null || !isTextual(contentType)) return null;
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    if (bytes.length === 0 || bytes.includes(0)) return null; // empty, or binary under a text label

    const cut = bytes.length > MAX_SNIPPET_BYTES;
    // a character split by the cut becomes a replacement mark, which is dropped below
    const text = new TextDecoder('utf-8', { fatal: false }).decode(cut ? bytes.subarray(0, MAX_SNIPPET_BYTES) : bytes)
        .replace(/�+$/u, '')
        .replace(CONTROL, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text ? { text, truncated: cut || wasCut } : null;
}

/**
 * Read at most MAX_SNIPPET_BYTES from the start of a response body, for no longer than a moment. Never throws: a body that
 * resets or stalls gives what arrived. The stream is always destroyed afterwards.
 * @param {import('stream').Readable} stream
 * @returns {Promise<{ bytes: Buffer, wasCut: boolean }>}  wasCut: there was more than was read
 */
export async function readSnippet(stream, { maxBytes = MAX_SNIPPET_BYTES, timeoutMs = SNIPPET_READ_MS } = {}) {
    const parts = [];
    let length = 0;
    let wasCut = false;
    let timer;

    const reading = (async () => {
        try {
            for await (const chunk of stream) {
                const take = Math.min(chunk.length, maxBytes - length);
                if (take > 0) { parts.push(chunk.subarray(0, take)); length += take; }
                if (length >= maxBytes) { wasCut = true; return; }
            }
        } catch {
            // a reset mid-page: what arrived is what there is
        }
    })();
    const timedOut = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });

    try {
        await Promise.race([reading, timedOut]);
    } finally {
        clearTimeout(timer);
        stream.destroy?.();
    }
    return { bytes: Buffer.concat(parts), wasCut };
}

const isStatus = (code) => Number.isInteger(code) && code >= 100 && code <= 599;

const CLEAN_IP = /^[0-9a-f:.]{2,45}$/i;

/**
 * The evidence as it is stored: only the parts that exist, or null when there are none.
 * @param {{ statusCode?: number, headers?: Object, address?: string|null, body?: Buffer|string|null, bodyWasCut?: boolean }} parts
 * @returns {{ statusCode?: number, headers?: Object, address?: string, snippet?: string, snippetTruncated?: true }|null}
 */
export function buildEvidence({ statusCode, headers, address, body, bodyWasCut = false } = {}) {
    const evidence = {};
    if (isStatus(statusCode)) evidence.statusCode = statusCode;

    const kept = safeHeaders(headers);
    if (Object.keys(kept).length > 0) evidence.headers = kept;

    if (typeof address === 'string' && CLEAN_IP.test(address)) evidence.address = address;

    const snippet = snippetOf(body, { contentType: kept['content-type'], wasCut: bodyWasCut });
    if (snippet) {
        evidence.snippet = snippet.text;
        if (snippet.truncated) evidence.snippetTruncated = true;
    }
    return Object.keys(evidence).length > 0 ? evidence : null;
}

/**
 * Evidence read back from storage or from an older writer: the same limits again, so a row that holds anything odd (a
 * long header, a wrong type) still comes out safe. null when nothing usable is left.
 */
export function cleanEvidence(stored) {
    if (!stored || typeof stored !== 'object') return null;
    const evidence = {};
    if (isStatus(stored.statusCode)) evidence.statusCode = stored.statusCode;

    const headers = safeHeaders(stored.headers);
    if (Object.keys(headers).length > 0) evidence.headers = headers;

    if (typeof stored.address === 'string' && CLEAN_IP.test(stored.address)) evidence.address = stored.address;

    if (typeof stored.snippet === 'string') {
        const text = stored.snippet.slice(0, MAX_SNIPPET_BYTES).replace(CONTROL, '').trim();
        if (text) {
            evidence.snippet = text;
            if (stored.snippetTruncated === true || stored.snippet.length > MAX_SNIPPET_BYTES) evidence.snippetTruncated = true;
        }
    }
    return Object.keys(evidence).length > 0 ? evidence : null;
}

export default { MAX_SNIPPET_BYTES, SAFE_HEADERS, safeHeaders, isTextual, snippetOf, readSnippet, buildEvidence, cleanEvidence };
