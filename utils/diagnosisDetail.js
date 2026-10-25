// utils/diagnosisDetail.js - a failed check as a short investigation: the likely causes in order, each with what it is
// based on, and the things to check in order, some of them as a command to copy
//
// utils/diagnosis.js says the one-line version and stays the text emails and chat use. This adds to it, for the page
// that has room: `causes` (most likely first, each with the evidence that points to it) and `checks` (what to do, in
// order). It still only ever says "likely": from outside we see the symptom, never the cause, and every cause here cites
// something the check actually measured or the server actually said.
//
// A command is only offered when the address is a plain host name or IP address: that is what keeps a copied command
// from being something else (a hostile address saved on a monitor must not become `; rm -rf` in somebody's terminal).
//
// Pure functions (no database, no sockets), so every case can be tested on its own.

import { diagnose } from './diagnosis.js';
import { hostFindings, hostLooksNormal, normalNote } from './hostContext.js';

/** @typedef {{ text: string, confidence: 'high'|'medium'|'low', evidence: string[] }} Cause */
/** @typedef {{ step: string, kind: 'command'|'manual', command?: string }} Check */

const MAX_CAUSES = 4;
const MAX_CHECKS = 6;
const MAX_EVIDENCE = 3;
const RANK = { high: 0, medium: 1, low: 2 };

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/**
 * The host, port and scheme of a monitor's address, only when they are safe to put in a command.
 * @param {string} url  as saved: a URL, or host:port for a TCP or database monitor
 * @param {string} [type]  website | api | tcp | database
 * @returns {{ host: string, port: number|null, https: boolean, origin: string|null }|null}
 */
export function targetOf(url, type) {
    const raw = String(url ?? '').trim();
    // The URL parser quietly drops tabs and line breaks, so a host with one in it would pass as another: refuse them first
    if (!raw || raw.length > 300 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
    try {
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
        const parsed = new URL(hasScheme ? raw : `${type === 'tcp' || type === 'database' ? 'tcp' : 'https'}://${raw}`);
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (!(HOSTNAME.test(host) || IPV4.test(host) || (host.includes(':') && IPV6.test(host)))) return null;
        const scheme = parsed.protocol.replace(':', '').toLowerCase();
        const port = parsed.port ? Number(parsed.port) : null;
        if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return null;
        const web = scheme === 'http' || scheme === 'https';
        const shownHost = host.includes(':') ? `[${host}]` : host;
        return { host, port, https: scheme === 'https', origin: web ? `${scheme}://${shownHost}${port ? `:${port}` : ''}` : null };
    } catch {
        return null;
    }
}

const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.round(Number(value)) : null);
const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const ms = (n) => `${withCommas(n)} ms`;
const oneLine = (text, max = 90) => {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const cause = (text, confidence, evidence = []) => ({ text, confidence, evidence: evidence.filter(Boolean).slice(0, MAX_EVIDENCE) });
const manual = (step) => ({ step, kind: 'manual' });

/** A command check, when the target allows one; the same step as plain advice when it does not */
const command = (target, step, make) => {
    const text = target ? make(target) : null;
    return text ? { step, kind: 'command', command: text } : manual(step);
};

// ── what the server said, read for clues ──

const headerOf = (evidence, name) => evidence?.headers?.[name] ?? null;
const poweredBy = (evidence) => headerOf(evidence, 'server') || headerOf(evidence, 'x-powered-by');
const viaCloudflare = (evidence) => Boolean(headerOf(evidence, 'cf-ray')) || /cloudflare/i.test(headerOf(evidence, 'server') || '');

const SNIPPET_CLUES = [
    { id: 'maintenance', test: /maintenance|back (soon|shortly)|be right back|temporarily (unavailable|down)/i,
        cause: 'The site is showing a maintenance page', confidence: 'high',
        checks: [manual('Check whether maintenance mode is switched on, and turn it off if the work is finished.')] },
    { id: 'database', test: /error establishing a database connection|database (is )?(down|unavailable)|could not connect to (the )?database|too many connections/i,
        cause: 'The application cannot reach its database', confidence: 'high',
        checks: [manual('Check the database server is running, accepts connections, and has not run out of connections or disk.')] },
    { id: 'challenge', test: /captcha|access denied|you have been blocked|attention required|verify you are (a )?human|request blocked/i,
        cause: 'A firewall or bot filter is blocking the check', confidence: 'high',
        checks: [manual('Allow Ping Pilott in the firewall or bot filter (WAF), or add the status it returns to the codes that count as up.')] },
    { id: 'default-page', test: /welcome to nginx|apache2? (ubuntu |debian )?default page|it works!|iis windows server/i,
        cause: 'The web server is showing its default page instead of the site', confidence: 'medium',
        checks: [manual('Check the virtual host or server block for this domain: the site is probably not matched to it.')] }
];

/** The first clue in the start of the page, as { clue, quote } */
const clueIn = (evidence) => {
    const text = evidence?.snippet;
    if (typeof text !== 'string' || !text) return null;
    // the visible words of an HTML page, not its tags
    const words = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    for (const clue of SNIPPET_CLUES) {
        const match = clue.test.exec(words);
        if (match) return { clue, quote: oneLine(words.slice(Math.max(0, match.index - 20), match.index + 70)) };
    }
    return null;
};

// ── per step ──

const dnsDetail = ({ timings, evidence, target }) => {
    const took = num(timings?.dns);
    const slow = took !== null && took >= 3000;
    const causes = slow
        ? [
            cause('The DNS provider is slow or not answering', 'high', [`The lookup had run ${ms(took)} when it gave up`]),
            cause('The domain’s name servers are wrong or down', 'medium'),
            cause('The domain has expired or was removed', 'low')
        ]
        : [
            cause('The domain has no DNS record, or the record was removed or mistyped', 'high', [took !== null ? `The lookup answered "not found" after ${ms(took)}` : 'The lookup answered "not found"']),
            cause('The domain registration has expired', 'medium'),
            cause('The DNS provider had an outage', 'low')
        ];
    const checks = [
        command(target, 'Look the name up yourself.', (t) => `dig +short ${t.host}`),
        command(target, 'Ask a public resolver, to rule out your own.', (t) => `nslookup ${t.host} 8.8.8.8`),
        manual('Check the domain has not expired at your registrar.'),
        manual('Check the name servers and the record at your DNS provider, and their status page.')
    ];
    return { causes, checks };
};

const connectDetail = ({ kind, timings, evidence, target }) => {
    const waited = num(timings?.connect);
    const where = evidence?.address ? `Resolved to ${evidence.address}` : null;
    const checks = [
        command(target, 'Try the port from your own machine.', (t) => (t.port || t.origin ? `nc -vz ${t.host} ${t.port || (t.https ? 443 : 80)}` : null)),
        command(target, 'Look for the route and where packets stop.', (t) => `traceroute ${t.host}`)
    ];
    if (kind === 'refused') {
        return {
            causes: [
                cause('The service is not running or not listening on this port', 'high', [waited !== null ? `Refused after ${ms(waited)}` : 'The connection was refused', where]),
                cause('A firewall is rejecting the connection', 'medium', [where]),
                cause('The address points at the wrong machine or port', 'low')
            ],
            checks: [
                manual('On the server, check the service is running (for example `systemctl status` for your web server).'),
                command(target, 'On the server, check something is listening on the port.', (t) => `ss -ltn | grep ':${t.port || (t.https ? 443 : 80)} '`),
                ...checks,
                manual('Check the firewall or security group allows the port.')
            ]
        };
    }
    if (kind === 'unreachable') {
        return {
            causes: [
                cause('The machine is offline, or has no network route', 'high', [where]),
                cause('A routing or provider network problem', 'medium')
            ],
            checks: [manual('Check the server is running at your hosting provider.'), ...checks, manual('Check your provider’s status page.')]
        };
    }
    return {
        causes: [
            cause('A firewall or security group is dropping the connection', 'high', [waited !== null ? `No connection after ${ms(waited)}` : 'No connection before the time limit', where]),
            cause('The server is offline or overloaded', 'medium', [where]),
            cause('A network or routing problem between the checker and the server', 'low')
        ],
        checks: [manual('Check the server is running and not out of memory or CPU.'), manual('Check the firewall or security group allows connections from anywhere (or from Ping Pilott).'), ...checks]
    };
};

const tlsDetail = ({ error, timings, target }) => {
    const text = String(error || '').toLowerCase();
    const took = num(timings?.tls);
    const handshake = took !== null ? `The handshake had run ${ms(took)}` : null;
    let causes;
    if (text.includes('expired')) causes = [cause('The certificate has expired', 'high', [String(error)])];
    else if (text.includes('altname') || text.includes('does not match') || text.includes('hostname')) causes = [cause('The certificate was issued for a different name', 'high', [oneLine(error)]), cause('The wrong site’s certificate is installed on the server', 'medium')];
    else if (text.includes('self-signed') || text.includes('self signed')) causes = [cause('The certificate is self-signed', 'high', [oneLine(error)])];
    else if (text.includes('unable to verify') || text.includes('unable to get')) causes = [cause('The certificate chain is incomplete: an intermediate certificate is missing', 'high', [oneLine(error)])];
    else causes = [
        cause('The port is not speaking HTTPS (for example plain HTTP on an HTTPS port)', 'medium', [handshake, oneLine(error)]),
        cause('The server only offers an old or unusual TLS setup', 'medium'),
        cause('A certificate problem', 'low')
    ];
    return {
        causes,
        checks: [
            command(target, 'Look at the certificate the server presents.', (t) => `openssl s_client -connect ${t.host}:${t.port || 443} -servername ${t.host} </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates`),
            command(target, 'See what a client sees.', (t) => (t.origin ? `curl -vI ${t.origin}` : null)),
            manual('Renew or replace the certificate, then reload the web server.'),
            manual('If renewal is automatic, check the renewal job ran (for example `certbot renew --dry-run`).')
        ]
    };
};

const CLOUDFLARE_STATUS = {
    520: ['Cloudflare got an unexpected answer from your server', 'high'],
    521: ['Cloudflare could not connect to your server: it is down or refusing Cloudflare', 'high'],
    522: ['Cloudflare timed out connecting to your server', 'high'],
    523: ['Cloudflare cannot find a route to your server', 'high'],
    524: ['Your server accepted the connection, but took too long to answer Cloudflare', 'high'],
    525: ['The TLS handshake between Cloudflare and your server failed', 'high'],
    526: ['Cloudflare does not accept your server’s certificate', 'high']
};

const responseDetail = ({ kind, statusCode, timings, evidence, target }) => {
    const causes = [];
    const checks = [];
    const status = Number.isInteger(statusCode) ? statusCode : evidence?.statusCode;
    const through = poweredBy(evidence);
    const answeredBy = through ? `Answered by ${oneLine(through, 60)}` : null;
    const waited = num(timings?.ttfb);
    const clue = clueIn(evidence);
    const logs = manual('Read the application and web server error logs around the time of the failure.');
    const curl = command(target, 'Request it yourself and look at the answer.', (t) => (t.origin ? `curl -sS -i --max-time 15 ${t.origin}` : null));

    if (kind === 'no_response') {
        causes.push(cause('The application accepted the connection and then hung', 'high', [waited !== null ? `Connected, then waited ${ms(waited)} with no answer` : 'Connected, but no answer before the time limit']));
        causes.push(cause('The server is overloaded (CPU, memory or workers all busy)', 'medium'));
        causes.push(cause('The page waits on a slow database or another service', 'medium'));
        checks.push(manual('Check CPU, memory and the number of busy workers on the server.'), logs, manual('Look for slow database queries, and for calls to other services with no timeout.'), curl);
    } else if (kind === 'reset') {
        causes.push(cause('The application crashed while handling the request', 'medium'));
        causes.push(cause('A proxy, load balancer or firewall is closing connections', 'medium'));
        causes.push(cause('The server ran out of memory or connections', 'low'));
        checks.push(logs, manual('Check proxy and load balancer logs for the same time.'), manual('Check for out-of-memory kills (for example `dmesg | grep -i kill`).'), curl);
    } else if (CLOUDFLARE_STATUS[status] && viaCloudflare(evidence)) {
        const [text, confidence] = CLOUDFLARE_STATUS[status];
        causes.push(cause(text, confidence, [`Status ${status}, a Cloudflare error`, headerOf(evidence, 'cf-ray') ? `cf-ray ${headerOf(evidence, 'cf-ray')}` : null]));
        checks.push(manual('Check your origin server is up and answering, away from Cloudflare.'), manual('Check the firewall allows Cloudflare’s addresses.'), logs);
    } else if (status === 502) {
        causes.push(cause('The application behind the web server is down or restarting', 'high', [`Status 502`, answeredBy]));
        causes.push(cause('The proxy points at the wrong upstream address or port', 'medium'));
        causes.push(cause('The application crashed or ran out of memory', 'medium'));
        checks.push(manual('Check the application process is running and listening where the proxy expects it.'), logs, manual('Check the upstream address in the proxy settings, and any recent deployment.'), curl);
    } else if (status === 503) {
        const retry = headerOf(evidence, 'retry-after');
        causes.push(cause('The server is overloaded or out of capacity', 'high', [`Status 503`, retry ? `Retry-After: ${oneLine(retry, 40)}` : null, answeredBy]));
        causes.push(cause('A deployment or maintenance window is in progress', 'medium'));
        causes.push(cause('The application is still starting', 'low'));
        checks.push(manual('Check server load and whether all workers are busy.'), manual('Check whether a deployment or maintenance mode is on.'), logs, curl);
    } else if (status === 504) {
        causes.push(cause('The application took too long to answer the proxy', 'high', [`Status 504`, waited !== null ? `The answer came after ${ms(waited)}` : null, answeredBy]));
        causes.push(cause('A slow database query or an external service the page waits for', 'medium'));
        causes.push(cause('The proxy’s timeout is shorter than the page needs', 'low'));
        checks.push(manual('Check for slow database queries and slow calls to other services.'), logs, manual('Compare the proxy’s timeout with how long the page takes.'), curl);
    } else if (status === 500) {
        causes.push(cause('The application hit an error handling the request', 'high', [`Status 500`, answeredBy]));
        causes.push(cause('A recent deployment or configuration change broke it', 'medium'));
        causes.push(cause('A dependency, such as the database, is failing', 'medium'));
        checks.push(logs, manual('Check what was deployed or changed just before it started failing.'), manual('Check the database and other services it depends on.'), curl);
    } else if (status === 401 || status === 403 || status === 429) {
        const evidenceLine = viaCloudflare(evidence) ? 'The answer came through Cloudflare' : answeredBy;
        causes.push(cause(status === 429 ? 'A rate limit is turning the check away' : 'A firewall, bot filter or login wall is turning the check away', 'high', [`Status ${status}`, evidenceLine, headerOf(evidence, 'retry-after') ? `Retry-After: ${oneLine(headerOf(evidence, 'retry-after'), 40)}` : null]));
        causes.push(cause('The page is meant to be private, so this answer is expected', 'medium'));
        checks.push(manual('Allow Ping Pilott in the firewall, WAF or rate limiter.'), manual(`If ${status} is the normal answer for this address, add it to the status codes that count as up in this monitor’s settings.`), curl);
    } else if (status === 404) {
        causes.push(cause('The page is not there: it moved, or a deployment went wrong', 'high', [`Status 404`, answeredBy]));
        causes.push(cause('The monitored address is wrong', 'medium'));
        checks.push(curl, manual('Open the address in a browser, and check the URL in this monitor’s settings.'), manual('Check the last deployment published the page.'));
    } else if (Number.isInteger(status) && status >= 500) {
        causes.push(cause('The application or something it depends on is failing', 'high', [`Status ${status}`, answeredBy]));
        causes.push(cause('A recent deployment or change', 'low'));
        checks.push(logs, curl);
    } else {
        causes.push(cause('The server answered with a status this monitor does not count as up', 'high', [Number.isInteger(status) ? `Status ${status}` : null, answeredBy]));
        checks.push(curl, manual('Check the status codes that count as up in this monitor’s settings.'));
    }

    if (clue) {
        causes.unshift(cause(clue.clue.cause, clue.clue.confidence, [`The page says: “${clue.quote}”`]));
        checks.unshift(...clue.clue.checks);
    }
    return { causes, checks };
};

const contentDetail = ({ evidence, target }) => {
    const clue = clueIn(evidence);
    const causes = [];
    const checks = [];
    if (clue) {
        causes.push(cause(clue.clue.cause, clue.clue.confidence, [`The page says: “${clue.quote}”`]));
        checks.push(...clue.clue.checks);
    }
    causes.push(cause('An error or maintenance page is being served with a normal status', 'medium', [evidence?.statusCode ? `Status ${evidence.statusCode}` : null]));
    causes.push(cause('The page changed, and the text this monitor looks for is gone', 'medium'));
    causes.push(cause('The page text is built by script in the browser, which a check cannot run', 'low'));
    checks.push(
        command(target, 'Request the page yourself and read what it returns.', (t) => (t.origin ? `curl -sS ${t.origin}` : null)),
        manual('Open the page in a browser and look for the text this monitor checks.'),
        manual('Check the text in this monitor’s settings still matches the page.')
    );
    return { causes, checks };
};

const BY_PHASE = {
    dns: dnsDetail,
    connect: connectDetail,
    tls: tlsDetail,
    response: responseDetail,
    content: contentDetail
};

const unique = (items, keyOf) => {
    const seen = new Set();
    return items.filter((item) => {
        const key = keyOf(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

/**
 * A failed check, with causes and checks added to the plain-words diagnosis.
 * @param {{ kind?: string|null, statusCode?: number|null, error?: string|null, failedPhase?: string|null,
 *           timings?: Object|null, evidence?: Object|null, url?: string, type?: string }} failure
 *   all as stored on a check (utils/failures.js, utils/failurePhase.js, utils/timings.js, utils/evidence.js); url and type
 *   are the monitor's, for the commands.
 * @returns {{ title: string, cause: string, action: string, failedPhase: string|null, causes: Cause[], checks: Check[] }|null}
 *   null when there is nothing to say (the same cases as `diagnose`)
 */
// Resource exhaustion explains a connection or response that failed from the server's side. It does not explain a
// bad address, a certificate, or the server answering correctly with "no" (401, 403, 404, 429 and the like).
const HOST_PHASES = ['connect', 'response', 'content'];
const isClientError = (statusCode) => Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500;

/** Causes, checks and a note from what the host agent saw around the failure (utils/hostContext.js) */
function hostDetail({ host, failedPhase, statusCode }) {
    if (!host || !HOST_PHASES.includes(failedPhase) || isClientError(statusCode)) return { causes: [], checks: [], note: null };

    const found = hostFindings(host);
    return {
        causes: found.map((f) => cause(f.text, f.severe ? 'high' : 'medium', f.evidence)),
        checks: found.map((f) => ({ step: f.check.step, kind: 'command', command: f.check.command })),
        note: found.length === 0 && hostLooksNormal(host) ? normalNote(host) : null
    };
}

export function diagnoseDetailed({ kind, statusCode, error, failedPhase, timings, evidence, url, type, host } = {}) {
    const base = diagnose({ kind, statusCode, error });
    if (!base) return null;

    const build = BY_PHASE[failedPhase];
    if (!build) return { ...base, failedPhase: null, causes: [], checks: [] };

    const target = targetOf(url, type);
    const detail = build({ kind, statusCode, error, timings, evidence, target });

    const fromHost = hostDetail({ host, failedPhase, statusCode });
    // Host causes go first so that, at equal confidence, what the agent measured outranks what could only be guessed
    const causes = unique([...fromHost.causes, ...detail.causes], (c) => c.text)
        .map((c, i) => ({ c, i }))
        .sort((a, b) => RANK[a.c.confidence] - RANK[b.c.confidence] || a.i - b.i)
        .map(({ c }) => c)
        .slice(0, MAX_CAUSES);
    const checks = unique([...detail.checks.slice(0, MAX_CHECKS - fromHost.checks.length), ...fromHost.checks], (c) => c.command || c.step).slice(0, MAX_CHECKS);

    return { ...base, failedPhase, causes, checks, ...(fromHost.note && { hostNote: fromHost.note }) };
}

export default { targetOf, diagnoseDetailed };
