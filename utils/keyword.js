// utils/keyword.js - "the page must say this" (or "must not say this"): a check that reads the page, not only the status
//
// A site can answer 200 and still be broken: a maintenance page, an error rendered inside a normal page, a login wall.
// A keyword check asks for the page and looks for a piece of text. It is for websites and APIs.
//
// The page is read with limits, because it is somebody else's server: at most MAX_BODY_BYTES of it (after decompression),
// and only for as long as the check has left. Past the limit the rest of the page is not looked at.

export const KEYWORD_MODES = ['present', 'absent'];
export const MAX_KEYWORD_LENGTH = 100;
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * The keyword as it is stored and used: { text, mode }, or null when there is none or it cannot be used.
 * `mode` is 'present' (the page must contain the text) unless it says 'absent' (the page must not).
 */
export const cleanKeyword = (keyword) => {
    if (!keyword || typeof keyword !== 'object') return null;
    const text = typeof keyword.text === 'string' ? keyword.text.trim() : '';
    if (!text || text.length > MAX_KEYWORD_LENGTH) return null;
    return { text, mode: keyword.mode === 'absent' ? 'absent' : 'present' };
};

const shown = (text) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

/** The sentence for a page that failed the check */
export const describeKeywordFailure = (keyword) => (keyword.mode === 'absent'
    ? `The page contains "${shown(keyword.text)}", which it should not.`
    : `The page does not contain "${shown(keyword.text)}".`);

/**
 * Read a response body looking for text, case-insensitively, and stop as soon as it is found, when MAX_BODY_BYTES have
 * been read, when the body ends, or when `timeoutMs` has passed. The stream is always destroyed afterwards.
 * @param {import('stream').Readable} stream  the response body (already decompressed)
 * @param {string} text
 * @param {{ maxBytes?: number, timeoutMs: number }} options
 * @returns {Promise<{ found: boolean, bytes: number, capped: boolean }>}
 * @throws a timeout (code ETIMEDOUT) if the body does not finish in time, or the stream's own error (a reset, say)
 */
export async function findInBody(stream, text, { maxBytes = MAX_BODY_BYTES, timeoutMs }) {
    const needle = text.toLowerCase();
    const decoder = new TextDecoder('utf-8', { fatal: false }); // a character split between two chunks is held back, not broken
    let tail = ''; // the end of what has been read, so text split between two chunks is still found
    let bytes = 0;
    let timer;

    const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
            stream.destroy();
            reject(Object.assign(new Error('Timed out reading the page'), { code: 'ETIMEDOUT' }));
        }, timeoutMs);
    });

    const reading = (async () => {
        for await (const chunk of stream) {
            bytes += chunk.length;
            const window = tail + decoder.decode(chunk, { stream: true }).toLowerCase();
            if (window.includes(needle)) return { found: true, bytes, capped: false };
            tail = needle.length > 1 ? window.slice(-(needle.length - 1)) : '';
            if (bytes >= maxBytes) return { found: false, bytes, capped: true };
        }
        return { found: false, bytes, capped: false };
    })();
    reading.catch(() => {}); // if the deadline wins, the read ending in an error afterwards is not news

    try {
        return await Promise.race([reading, timedOut]);
    } finally {
        clearTimeout(timer);
        stream.destroy();
    }
}

export default { KEYWORD_MODES, MAX_KEYWORD_LENGTH, MAX_BODY_BYTES, cleanKeyword, describeKeywordFailure, findInBody };
