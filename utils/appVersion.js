// utils/appVersion.js - which build of the mobile app is current
//
// The Android app is sideloaded (no store to announce updates), so it asks the backend. The answer comes from
// environment variables, so shipping a new APK is: build it, then set these in the host's dashboard.
//
//   APP_LATEST_VERSION_CODE  the newest build's Android versionCode (a whole number, bumped for every build)
//   APP_MIN_VERSION_CODE     builds older than this must update before using the app (optional)
//   APP_DOWNLOAD_URL         https link to the build page or APK
//   APP_RELEASE_NOTES        one line on what's new (optional)
//
// Pure functions (no database), so the rules can be tested alone.

const asVersionCode = (value) => {
    const n = Number(String(value ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
};

const asText = (value, max) => {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
};

/** Only ever hand out web links: the app opens this URL, so it must not be something else */
const asHttpsUrl = (value) => {
    const text = String(value ?? '').trim();
    if (!/^https:\/\//i.test(text)) return null;
    try {
        return new URL(text).toString();
    } catch {
        return null;
    }
};

/** What GET /api/app/version returns. Everything is null when nothing is configured. */
export function buildVersionInfo(env = process.env) {
    return {
        latestVersionCode: asVersionCode(env.APP_LATEST_VERSION_CODE),
        minVersionCode: asVersionCode(env.APP_MIN_VERSION_CODE),
        downloadUrl: asHttpsUrl(env.APP_DOWNLOAD_URL),
        notes: asText(env.APP_RELEASE_NOTES, 300),
    };
}

export default { buildVersionInfo };
