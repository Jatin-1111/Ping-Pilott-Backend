// routes/installRoute.js - GET /install.sh: the script that installs the host agent on a Linux server
//
//   curl -fsSL https://<this api>/install.sh | sudo PINGPILOT_TOKEN=ppa_... sh
//
// The script is the agent repository's install.sh (github.com/Jatin-1111/pingpilot-agent), kept here as assets/install.sh
// so it is served from the same address as the API. When that script changes, copy it over (tests/installRoute.test.js
// compares the two when both repositories are checked out side by side).
//
// It is a program people run as root, so it is served exactly as it is in the file, as plain text (a browser shows it
// instead of running or downloading it), and it is refused outright if it does not look complete: the script is one
// function called on its last line, so a truncated copy would otherwise be served as if it were whole.

import fs from 'node:fs';
import { hostMetricsEnabled } from '../utils/hostMetrics.js';
import logger from '../utils/logger.js';

const SCRIPT_PATH = new URL('../assets/install.sh', import.meta.url);

/** @param {Object} [deps]  replaceable in tests */
export function createInstallHandler({ read = () => fs.readFileSync(SCRIPT_PATH, 'utf8'), enabled = hostMetricsEnabled } = {}) {
    let script = null;

    return (req, res) => {
        if (!enabled()) return res.status(404).json({ status: 'error', message: 'Not found', code: 'NOT_FOUND' });

        if (script === null) {
            // line endings are made LF here as well as in .gitattributes: a CRLF script fails in sh with a baffling error
            const text = read().replace(/\r\n/g, '\n');
            if (!text.startsWith('#!/bin/sh\n') || !text.trimEnd().endsWith('main "$@"')) {
                logger.error('assets/install.sh does not look like the complete installer; not serving it');
                return res.status(500).json({ status: 'error', message: 'The installer is not available right now', code: 'SERVER_ERROR' });
            }
            script = text;
        }

        res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        res.status(200).send(script);
    };
}

export default createInstallHandler();
