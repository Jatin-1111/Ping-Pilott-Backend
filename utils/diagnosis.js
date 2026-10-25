// utils/diagnosis.js - a failed check, said in plain words: what happened, the likely cause, and what to try first
//
// The kind (utils/failures.js) and the HTTP status are what the check measured. This turns them into a sentence a
// person can act on at 3am. It only ever says "likely": from outside we see the symptom, not the cause, and a confident
// wrong answer is worse than none. The raw `error` sentence is never replaced; callers show both.
//
// Pure functions (no database), so every case can be tested on its own.

/** @typedef {{ title: string, cause: string, action: string }} Diagnosis */

const HTTP_BY_STATUS = {
    500: {
        title: 'The site hit an error',
        cause: 'The server is up, but the code handling the request failed. This is usually an application bug, a bad deployment, or a broken dependency such as the database.',
        action: 'Check the application error logs and any recent deployment.'
    },
    502: {
        title: 'The server is up, but the app behind it is not answering',
        cause: 'A web server or proxy answered, but the application it passes requests to is likely crashed, restarting or not running.',
        action: 'Check that the application process is running, and the upstream address in your proxy settings.'
    },
    503: {
        title: 'The server cannot take requests right now',
        cause: 'The server is up but likely overloaded, in maintenance mode, or the application is still starting.',
        action: 'Check server load, whether maintenance mode is on, and whether the app finished starting.'
    },
    504: {
        title: 'The app behind the server took too long to answer',
        cause: 'A web server or proxy is up, but the application behind it did not respond in time. A slow database query or an overloaded app is a common reason.',
        action: 'Check application load, slow database queries and any external service the page waits for.'
    },
    404: {
        title: 'The page was not found',
        cause: 'The server answered, but nothing exists at this address. The page may have moved, a deployment may have gone wrong, or the monitored address may be wrong.',
        action: 'Open the address in a browser, and check the URL in this monitor’s settings.'
    }
};

const ANSWERED_BUT_REFUSED = {
    401: 'is asking for a login',
    403: 'is refusing the check',
    429: 'is limiting requests'
};

const httpDiagnosis = (statusCode) => {
    if (!Number.isInteger(statusCode)) {
        return {
            title: 'The server answered with an error',
            cause: 'The server is reachable, but replied with a status that does not count as up.',
            action: 'Open the address in a browser to see what it returns.'
        };
    }
    if (HTTP_BY_STATUS[statusCode]) return HTTP_BY_STATUS[statusCode];
    if (ANSWERED_BUT_REFUSED[statusCode]) {
        return {
            title: 'The server answered, but not with a page',
            cause: `The site is alive, but it ${ANSWERED_BUT_REFUSED[statusCode]} (a login wall, a bot filter, an IP block or a rate limit are the usual reasons).`,
            action: `If this is expected, add ${statusCode} to the status codes that count as up in this monitor’s settings.`
        };
    }
    if (statusCode >= 500) {
        return {
            title: `The server reported an error (${statusCode})`,
            cause: 'The server is reachable, but it says it failed to handle the request. This usually points to the application or something it depends on.',
            action: 'Check the application and server logs around the time of the failure.'
        };
    }
    return {
        title: `Unexpected response (${statusCode})`,
        cause: 'The server answered with a status that this monitor does not count as up.',
        action: 'Open the address in a browser, and check the status codes that count as up in this monitor’s settings.'
    };
};

// A certificate problem is one kind (tls). The library says which in its message, so read that.
const tlsDiagnosis = (message = '') => {
    const text = String(message).toLowerCase();
    if (text.includes('expired')) {
        return {
            title: 'The security certificate has expired',
            cause: 'The site’s HTTPS certificate is past its expiry date, so connections are rejected.',
            action: 'Renew the certificate (or fix automatic renewal) and reload the web server.'
        };
    }
    if (text.includes('altname') || text.includes('does not match') || text.includes('hostname')) {
        return {
            title: 'The certificate does not match this address',
            cause: 'The site presented a certificate issued for a different domain name, which usually means the wrong certificate is installed.',
            action: 'Install a certificate that covers this exact domain name, including any www version.'
        };
    }
    if (text.includes('self-signed') || text.includes('self signed')) {
        return {
            title: 'The certificate is self-signed',
            cause: 'The site uses a certificate that no trusted authority issued, so it cannot be verified.',
            action: 'Use a certificate from a trusted authority, such as a free Let’s Encrypt certificate.'
        };
    }
    if (text.includes('unable to verify') || text.includes('unable to get')) {
        return {
            title: 'The certificate chain is incomplete',
            cause: 'The site’s certificate cannot be traced to a trusted authority, which often means the intermediate certificate is missing from the server setup.',
            action: 'Install the full certificate chain (including intermediate certificates) on the server.'
        };
    }
    return {
        title: 'A secure connection could not be made',
        cause: 'The HTTPS handshake failed. A certificate problem or an unsupported security setting on the server is likely.',
        action: 'Check the certificate and TLS settings, for example with an online SSL checker.'
    };
};

const BY_KIND = {
    dns: {
        title: 'The domain name could not be found',
        cause: 'The name did not resolve to an address, so nothing could connect. An expired domain, a missing or wrong DNS record, or a DNS provider outage are the usual reasons.',
        action: 'Check the domain is still registered and its DNS records point to your server.'
    },
    refused: {
        title: 'Nothing is accepting connections',
        cause: 'The machine answered, but nothing is listening on that port. The web server or application has likely stopped, or a firewall is rejecting the connection.',
        action: 'Check the service is running, restart it if needed, and check the firewall allows the port.'
    },
    reset: {
        title: 'The server cut the connection',
        cause: 'The server accepted the connection and then dropped it. The app may have crashed mid-request, or a proxy or firewall is closing connections, or the server is overloaded.',
        action: 'Check the application and proxy logs around the time of the failure.'
    },
    timeout: {
        title: 'The server did not answer in time',
        cause: 'No response came before the time limit. The server may be overloaded or stuck, or a network or firewall problem is blocking the way.',
        action: 'Check server load (CPU, memory, database) and that the machine is online and reachable.'
    },
    unreachable: {
        title: 'The server cannot be reached',
        cause: 'There is no network route to the server. The machine may be offline, or there is a network or routing problem at the host.',
        action: 'Check the server is running and has network connectivity at your hosting provider.'
    },
    content: {
        title: 'The page loaded, but its content is wrong',
        cause: 'The page answered, but the text this monitor looks for was missing (or unwanted text appeared). That often means an error or maintenance page is being served with a normal status.',
        action: 'Open the page and check what it shows, and the keyword in this monitor’s settings.'
    },
    blocked: {
        title: 'This address cannot be checked',
        cause: 'It points to a private or internal network, which Ping Pilott cannot reach from the internet.',
        action: 'Monitor a public address instead.'
    },
    invalid: {
        title: 'The saved address cannot be checked',
        cause: 'The address is not in a form that can be checked.',
        action: 'Edit the address in this monitor’s settings (a TCP check needs host:port).'
    }
};

/** The status an HTTP failure sentence starts with ("HTTP 503: Service Unavailable"), for rows saved without a code */
const statusFromMessage = (message) => {
    const found = /^HTTP (\d{3})\b/.exec(String(message || ''));
    return found ? Number(found[1]) : null;
};

/**
 * @param {{ kind?: string|null, statusCode?: number|null, error?: string|null }} failure
 *   kind and statusCode as stored on a check (utils/failures.js); error is the sentence the user already sees. An HTTP
 *   failure with no stored status reads it from the start of that sentence.
 * @returns {Diagnosis|null}  null when there is nothing to say: no failure, or one whose kind says nothing useful ('other')
 */
export function diagnose({ kind, statusCode, error } = {}) {
    if (!kind) return null;
    if (kind === 'http') return httpDiagnosis(Number.isInteger(statusCode) ? statusCode : statusFromMessage(error));
    if (kind === 'tls') return tlsDiagnosis(error);
    return BY_KIND[kind] ?? null;
}

/** A plain-text rendering for emails and chat: three short lines */
export const diagnosisLines = (diagnosis) => (diagnosis
    ? [`What happened: ${diagnosis.title}.`, `Likely cause: ${diagnosis.cause}`, `Try first: ${diagnosis.action}`]
    : []);

export default { diagnose, diagnosisLines };
