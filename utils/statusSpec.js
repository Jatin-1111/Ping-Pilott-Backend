// utils/statusSpec.js - which HTTP status codes count as "up" for a server
//
// By default a server is up when it answers 200 to 399 (a success or a redirect). A site behind a login, or one that
// refuses bots, answers 401 or 403 while being perfectly alive; an owner can say so with a list such as "200-399,401,403".
// "100-599" counts any answer at all.

export const DEFAULT_STATUS_SPEC = '200-399';
export const DEFAULT_RANGES = [[200, 399]];

const MAX_LENGTH = 60;
const MAX_TOKENS = 10;

/**
 * @param {string} spec  "200-399,401,403": codes and ranges, separated by commas. Empty means the default.
 * @returns {{ ok: true, ranges: number[][], spec: string, isDefault: boolean } | { ok: false, error: string }}
 */
export function parseStatusSpec(spec) {
    const text = String(spec ?? '').trim();
    if (text === '') return { ok: true, ranges: DEFAULT_RANGES, spec: '', isDefault: true };
    if (text.length > MAX_LENGTH) return { ok: false, error: `Use at most ${MAX_LENGTH} characters.` };

    const tokens = text.split(',').map((t) => t.trim());
    if (tokens.length > MAX_TOKENS) return { ok: false, error: `Use at most ${MAX_TOKENS} codes or ranges.` };

    const ranges = [];
    for (const token of tokens) {
        const match = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(token);
        if (!match) return { ok: false, error: `"${token}" is not a status code or a range such as 200-299.` };
        const low = Number(match[1]);
        const high = match[2] ? Number(match[2]) : low;
        if (low < 100 || high > 599) return { ok: false, error: 'Status codes are between 100 and 599.' };
        if (low > high) return { ok: false, error: `"${token}" runs backwards.` };
        ranges.push([low, high]);
    }
    return { ok: true, ranges, spec: ranges.map(([low, high]) => (low === high ? `${low}` : `${low}-${high}`)).join(','), isDefault: false };
}

export const isValidStatusSpec = (spec) => parseStatusSpec(spec).ok;

/** The text to store: tidied, or '' for "the default" */
export const normalizeStatusSpec = (spec) => {
    const parsed = parseStatusSpec(spec);
    return parsed.ok ? parsed.spec : '';
};

/**
 * The ranges a check uses. A stored value that cannot be read counts as the default: a bad row must never make every
 * check of that server fail.
 */
export const acceptedRanges = (spec) => {
    const parsed = parseStatusSpec(spec);
    return parsed.ok ? parsed.ranges : DEFAULT_RANGES;
};

export const statusAccepted = (status, ranges = DEFAULT_RANGES) => ranges.some(([low, high]) => status >= low && status <= high);

export default { DEFAULT_STATUS_SPEC, parseStatusSpec, isValidStatusSpec, normalizeStatusSpec, acceptedRanges, statusAccepted };
