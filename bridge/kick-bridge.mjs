import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { chromium } from 'playwright';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const KICK_HOME_URL = 'https://kick.com/';
const KICK_API_BASE_URL = 'https://kick.com';
const KICK_WEB_URL = 'https://web.kick.com';
const FOLLOWED_CHANNELS_ENDPOINT = `${KICK_API_BASE_URL}/api/v2/channels/followed`;
const REMOTE_DEBUGGING_HOST = '127.0.0.1';
const EXISTING_BROWSER_CONNECT_TIMEOUT_MS = 5_000;
const REMOTE_DEBUGGING_STARTUP_TIMEOUT_MS = 30_000;
const REMOTE_DEBUGGING_POLL_INTERVAL_MS = 500;
const LOGIN_CAPTURE_TIMEOUT_MS = 10 * 60_000;
const LOGIN_CAPTURE_POLL_INTERVAL_MS = 1_000;
const BRIDGE_PAGE_WAIT_TIMEOUT_MS = 10_000;
const BROWSER_FETCH_TIMEOUT_MS = 10_000;
const BACKGROUND_FETCH_WARMUP_MS = 1_500;
const CHANNEL_CHAT_DOM_WARMUP_MS = 2_500;
const MAX_FOLLOWED_CURSOR_PAGES = 25;
const RECENT_CHANNELS_LIMIT = 25;
const CHANNEL_HTML_FETCH_TIMEOUT_SECONDS = 20;
const BROWSER_RECONNECT_REQUIRED_MESSAGE = 'Reconnect Kick browser and keep that window open to restore website-only reads.';

const SYSTEM_BROWSER_CANDIDATES = [
  {
    label: 'Google Chrome',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  },
  {
    label: 'Microsoft Edge',
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  },
  {
    label: 'Microsoft Edge',
    executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  }
];

const RESERVED_PATHS = new Set([
  '',
  'api',
  'categories',
  'chat',
  'clips',
  'downloads',
  'explore',
  'following',
  'home',
  'livestreams',
  'messages',
  'moderation',
  'notifications',
  'privacy',
  'search',
  'settings',
  'subscriptions',
  'teams',
  'videos'
]);

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command) {
  printHelp();
  process.exit(1);
}

try {
  switch (command) {
    case 'login':
      await loginFlow(args);
      break;
    case 'serve':
      await serveBridge(args);
      break;
    case 'fetch-live-following':
      await fetchLiveFollowing(args);
      break;
    case 'fetch-channel-chat':
      await fetchChannelChat(args);
      break;
    default:
      printHelp();
      process.exit(1);
  }
} catch (error) {
  await safeUpdateStatus(args['status-file'], 'ERROR', error instanceof Error ? error.message : 'Kick bridge failed.', null);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function parseArgs(values) {
  const parsed = { _: [] };

  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];

    if (current.startsWith('--')) {
      parsed[current.slice(2)] = values[index + 1];
      index += 1;
    } else {
      parsed._.push(current);
    }
  }

  return parsed;
}

async function loginFlow(cliArgs) {
  const statusFile = requireArg(cliArgs, 'status-file');
  const cookieFile = requireArg(cliArgs, 'cookie-file');
  const sessionFile = requireArg(cliArgs, 'session-file');
  const profileDir = requireArg(cliArgs, 'profile-dir');
  const metaFile = requireArg(cliArgs, 'meta-file');
  const resolvedProfileDir = path.resolve(profileDir);

  const existingMetadata = await readJson(metaFile, null);
  let loginBridge = null;

  if (existingMetadata?.debuggingPort) {
    try {
      loginBridge = await openExistingBrowserBridge({
        debuggingPort: existingMetadata.debuggingPort
      });
    } catch {
      loginBridge = null;
    }
  }

  if (!loginBridge) {
    loginBridge = await openBrowserBridge({
      preferredBrowserPath: existingMetadata?.browserPath || process.env.KICK_BROWSER_PATH,
      profileDir: resolvedProfileDir,
      startUrl: KICK_HOME_URL,
      startMinimized: false,
      detachProcess: true
    });
  }

  const { browser, context, page, browserInfo, browserProcess, debuggingPort } = loginBridge;
  browserProcess?.unref?.();

  await writeJson(metaFile, {
    browserLabel: browserInfo.label,
    browserPath: browserInfo.executablePath === 'already-running'
      ? (existingMetadata?.browserPath || resolveChromiumBrowser(process.env.KICK_BROWSER_PATH).executablePath)
      : browserInfo.executablePath,
    profileDir: resolvedProfileDir,
    debuggingPort,
    capturedAt: now()
  });

  await safeUpdateStatus(
    statusFile,
    'RUNNING',
    loginBridge.ownsBrowserProcess
      ? `${browserInfo.label} was opened for Kick login. Finish login there and the app will store your session automatically.`
      : 'Kick login browser is already open. Finish login there and the app will store your session automatically.',
    null
  );

  try {
    await ensureKickHomePage(page).catch(() => undefined);

    const session = await waitForAuthenticatedSession({
      context,
      page,
      cookieFile,
      sessionFile
    });

    await safeUpdateStatus(
      statusFile,
      'READY',
      `Captured Kick browser session for ${session.profile.username}. Keep that browser window open, then load followings or chat to verify live sync.`,
      session
    );
  } finally {
    if (loginBridge.ownsBrowserProcess) {
      await disconnectBrowserBridge(browser);
    } else {
      await closeBrowserBridge(page, browser, browserProcess, loginBridge.ownsBrowserProcess, loginBridge.ownsPage);
    }
  }
}

async function fetchLiveFollowing(cliArgs) {
  const statusFile = requireArg(cliArgs, 'status-file');
  const cookieFile = requireArg(cliArgs, 'cookie-file');
  const sessionFile = requireArg(cliArgs, 'session-file');
  const metaFile = requireArg(cliArgs, 'meta-file');
  const outputFile = requireArg(cliArgs, 'output-file');
  const profileDir = requireArg(cliArgs, 'profile-dir');

  const metadata = await readJson(metaFile, {});
  const storedCookies = await readJson(cookieFile, []);
  const storedSession = await readKickSession(sessionFile);

  if (!hasValidKickSession(storedSession)) {
    await invalidateSavedSession(sessionFile, cookieFile);
    await safeUpdateStatus(statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
    throw new Error('Kick session is missing or expired. Sign in again.');
  }

  const session = await openConnectedBrowserBridge({
    debuggingPort: metadata.debuggingPort,
    statusFile,
    storedSession,
    profileDir,
    preferredBrowserPath: metadata.browserPath || process.env.KICK_BROWSER_PATH
  });

  const { browser, context, page, browserInfo, browserProcess, ownsBrowserProcess } = session;

  try {
    if (Array.isArray(storedCookies) && storedCookies.length > 0) {
      await context.addCookies(storedCookies).catch(() => undefined);
    }

    const channels = await fetchFollowedChannelsFromBrowser(page);

    await writeJson(outputFile, channels);
    const refreshedCookies = await context.cookies(KICK_HOME_URL).catch(() => []);
    if (Array.isArray(refreshedCookies) && refreshedCookies.length > 0) {
      await writeJson(cookieFile, refreshedCookies);
    }

    await safeUpdateStatus(
      statusFile,
      'READY',
      channels.length === 0
        ? `Connected as ${storedSession.profile.username}, but no live followings were found.`
        : `Loaded ${channels.length} live following channels for ${storedSession.profile.username}.`,
      storedSession
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kick bridge failed to load channels.';

    if (message.toLowerCase().includes('sign in again')) {
      await invalidateSavedSession(sessionFile, cookieFile);
      await safeUpdateStatus(statusFile, 'IDLE', message, null);
    } else {
      await safeUpdateStatus(statusFile, 'ERROR', `${browserInfo.label} failed while loading followings: ${message}`, storedSession);
    }

    throw error;
  } finally {
    await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess, session.ownsPage);
  }
}

function parseOptionalNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeChannelChatRequest({ channelSlug, channelId = null, channelUserId = null, displayName = null, avatarUrl = null, fast = false }) {
  return {
    channelSlug: String(channelSlug || '').trim().toLowerCase(),
    channelId: parseOptionalNumber(channelId),
    channelUserId: parseOptionalNumber(channelUserId),
    displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : null,
    avatarUrl: typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : null,
    fast: parseOptionalBoolean(fast)
  };
}

async function fetchChannelChat(cliArgs) {
  const statusFile = requireArg(cliArgs, 'status-file');
  const cookieFile = requireArg(cliArgs, 'cookie-file');
  const sessionFile = requireArg(cliArgs, 'session-file');
  const metaFile = requireArg(cliArgs, 'meta-file');
  const outputFile = requireArg(cliArgs, 'output-file');
  const profileDir = requireArg(cliArgs, 'profile-dir');
  const chatRequest = normalizeChannelChatRequest({
    channelSlug: requireArg(cliArgs, 'channel-slug'),
    channelId: cliArgs['channel-id'],
    channelUserId: cliArgs['channel-user-id'],
    displayName: cliArgs['display-name'],
    avatarUrl: cliArgs['avatar-url'],
    fast: cliArgs.fast
  });

  if (!chatRequest.channelSlug) {
    throw new Error('Kick channel slug is required.');
  }

  const metadata = await readJson(metaFile, {});
  const storedCookies = await readJson(cookieFile, []);
  const storedSession = await readKickSession(sessionFile);

  if (!hasValidKickSession(storedSession)) {
    await invalidateSavedSession(sessionFile, cookieFile);
    await safeUpdateStatus(statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
    throw new Error('Kick session is missing or expired. Sign in again.');
  }

  const session = await openConnectedBrowserBridge({
    debuggingPort: metadata.debuggingPort,
    statusFile,
    storedSession,
    profileDir,
    preferredBrowserPath: metadata.browserPath || process.env.KICK_BROWSER_PATH
  });

  const { browser, context, page, browserProcess, ownsBrowserProcess } = session;

  try {
    if (Array.isArray(storedCookies) && storedCookies.length > 0) {
      await context.addCookies(storedCookies).catch(() => undefined);
    }

    const chat = await fetchChannelChatFromBrowser(page, chatRequest);
    await writeJson(outputFile, chat);

    const refreshedCookies = await context.cookies(KICK_HOME_URL).catch(() => []);
    if (Array.isArray(refreshedCookies) && refreshedCookies.length > 0) {
      await writeJson(cookieFile, refreshedCookies);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kick bridge failed to load channel chat.';
    if (message.toLowerCase().includes('sign in again')) {
      await invalidateSavedSession(sessionFile, cookieFile);
      await safeUpdateStatus(statusFile, 'IDLE', message, null);
    }

    throw error;
  } finally {
    await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess, session.ownsPage);
  }
}

async function serveBridge(cliArgs) {
  const statusFile = requireArg(cliArgs, 'status-file');
  const cookieFile = requireArg(cliArgs, 'cookie-file');
  const sessionFile = requireArg(cliArgs, 'session-file');
  const metaFile = requireArg(cliArgs, 'meta-file');
  const profileDir = requireArg(cliArgs, 'profile-dir');

  const storedSession = await readKickSession(sessionFile);

  if (!hasValidKickSession(storedSession)) {
    await invalidateSavedSession(sessionFile, cookieFile);
    await safeUpdateStatus(statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
    throw new Error('Kick session is missing or expired. Sign in again.');
  }

  writeProtocolLine({ type: 'ready' });

  const state = {
    statusFile,
    cookieFile,
    sessionFile,
    metaFile,
    profileDir
  };

  const lineReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  let queue = Promise.resolve();
  lineReader.on('line', (line) => {
    queue = queue.then(() => handleServiceRequest(line, state));
  });

  await new Promise((resolve) => {
    lineReader.once('close', resolve);
  });

  await queue.catch(() => undefined);
}

async function handleServiceRequest(line, state) {
  let requestId = null;

  try {
    const request = JSON.parse(line);
    requestId = request?.id ? String(request.id) : null;

    if (request?.command === 'fetch-live-following') {
      const storedSession = await readKickSession(state.sessionFile);
      if (!hasValidKickSession(storedSession)) {
        await invalidateSavedSession(state.sessionFile, state.cookieFile);
        await safeUpdateStatus(state.statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
        throw new Error('Kick session is missing or expired. Sign in again.');
      }

      const session = await openServiceBridge(state, storedSession);
      const { browser, context, page, browserInfo, browserProcess, ownsBrowserProcess } = session;

      try {
        const channels = await fetchFollowedChannelsFromBrowser(page);
        await persistServiceCookies(context, state.cookieFile);
        await safeUpdateStatus(
          state.statusFile,
          'READY',
          channels.length === 0
            ? `Connected as ${storedSession.profile.username}, but no live followings were found.`
            : `Loaded ${channels.length} live following channels for ${storedSession.profile.username}.`,
          storedSession
        );

        writeProtocolLine({
          id: requestId,
          ok: true,
          result: channels
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Kick bridge failed to load channels.';

        if (message.toLowerCase().includes('sign in again')) {
          await invalidateSavedSession(state.sessionFile, state.cookieFile);
          await safeUpdateStatus(state.statusFile, 'IDLE', message, null);
        } else {
          await safeUpdateStatus(state.statusFile, 'ERROR', `${browserInfo.label} failed while loading followings: ${message}`, storedSession);
        }

        throw error;
      } finally {
        await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess, session.ownsPage);
      }
      return;
    }

    if (request?.command === 'fetch-recent-channel-slugs') {
      const storedSession = await readKickSession(state.sessionFile);
      if (!hasValidKickSession(storedSession)) {
        await invalidateSavedSession(state.sessionFile, state.cookieFile);
        await safeUpdateStatus(state.statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
        throw new Error('Kick session is missing or expired. Sign in again.');
      }

      const session = await openServiceBridge(state, storedSession);
      const { browser, context, page, browserProcess, ownsBrowserProcess } = session;

      try {
        const recentChannelSlugs = await fetchRecentChannelSlugsFromBrowser(page);
        await persistServiceCookies(context, state.cookieFile);

        writeProtocolLine({
          id: requestId,
          ok: true,
          result: recentChannelSlugs
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Kick bridge failed to load recent browser channels.';

        if (message.toLowerCase().includes('sign in again')) {
          await invalidateSavedSession(state.sessionFile, state.cookieFile);
          await safeUpdateStatus(state.statusFile, 'IDLE', message, null);
        }

        throw error;
      } finally {
        await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess, session.ownsPage);
      }
      return;
    }

    if (request?.command === 'fetch-channel-chat') {
      const chatRequest = normalizeChannelChatRequest({
        channelSlug: request.channelSlug,
        channelId: request.channelId,
        channelUserId: request.channelUserId,
        displayName: request.displayName,
        avatarUrl: request.avatarUrl,
        fast: request.fast
      });

      if (!chatRequest.channelSlug) {
        throw new Error('Kick channel slug is required.');
      }

      const storedSession = await readKickSession(state.sessionFile);
      if (!hasValidKickSession(storedSession)) {
        await invalidateSavedSession(state.sessionFile, state.cookieFile);
        await safeUpdateStatus(state.statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
        throw new Error('Kick session is missing or expired. Sign in again.');
      }

      const session = await openServiceBridge(state, storedSession);
      const { browser, context, page, browserInfo, browserProcess, ownsBrowserProcess } = session;

      try {
        const chat = await fetchChannelChatFromBrowser(page, chatRequest);
        await persistServiceCookies(context, state.cookieFile);
        await safeUpdateStatus(
          state.statusFile,
          'READY',
          chat.messages.length === 0
            ? `Connected as ${storedSession.profile.username}, but Kick returned no recent chat messages for ${chatRequest.channelSlug}.`
            : `Loaded ${chat.messages.length} recent chat messages for ${chatRequest.channelSlug}.`,
          storedSession
        );

        writeProtocolLine({
          id: requestId,
          ok: true,
          result: chat
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Kick bridge failed to load channel chat.';

        if (message.toLowerCase().includes('sign in again')) {
          await invalidateSavedSession(state.sessionFile, state.cookieFile);
          await safeUpdateStatus(state.statusFile, 'IDLE', message, null);
        } else {
          await safeUpdateStatus(state.statusFile, 'ERROR', `${browserInfo.label} failed while loading chat for ${chatRequest.channelSlug}: ${message}`, storedSession);
        }

        throw error;
      } finally {
        await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess, session.ownsPage);
      }
      return;
    }

    throw new Error(`Unknown bridge service command: ${request?.command || 'unknown'}`);
  } catch (error) {
    writeProtocolLine({
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'Kick bridge service failed.'
    });
  }
}

async function persistServiceCookies(context, cookieFile) {
  const refreshedCookies = await context.cookies(KICK_HOME_URL).catch(() => []);
  if (Array.isArray(refreshedCookies) && refreshedCookies.length > 0) {
    await writeJson(cookieFile, refreshedCookies);
  }
}

async function openServiceBridge(state, storedSession) {
  const metadata = await readJson(state.metaFile, {});
  const storedCookies = await readJson(state.cookieFile, []);
  const session = await openConnectedBrowserBridge({
    debuggingPort: metadata.debuggingPort,
    statusFile: state.statusFile,
    storedSession,
    profileDir: state.profileDir,
    preferredBrowserPath: metadata.browserPath || process.env.KICK_BROWSER_PATH
  });

  if (Array.isArray(storedCookies) && storedCookies.length > 0) {
    await session.context.addCookies(storedCookies).catch(() => undefined);
  }

  return session;
}

function writeProtocolLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function waitForAuthenticatedSession({ context, page, cookieFile, sessionFile }) {
  const deadline = Date.now() + LOGIN_CAPTURE_TIMEOUT_MS;
  let activePage = page;

  while (Date.now() < deadline) {
    activePage = await ensureActiveBridgePage(context, activePage);

    let session = null;
    try {
      session = await captureKickSession(context, activePage);
    } catch (error) {
      if (isClosedTargetError(error)) {
        activePage = null;
        await delay(LOGIN_CAPTURE_POLL_INTERVAL_MS);
        continue;
      }

      throw error;
    }

    if (session) {
      await writeJson(sessionFile, session);
      const refreshedCookies = await context.cookies(KICK_HOME_URL).catch(() => []);
      if (Array.isArray(refreshedCookies) && refreshedCookies.length > 0) {
        await writeJson(cookieFile, refreshedCookies);
      }
      return session;
    }

    await delay(LOGIN_CAPTURE_POLL_INTERVAL_MS);
  }

  throw new Error('Kick login timed out before a session token was captured.');
}

async function captureKickSession(context, page) {
  const cookies = await context.cookies(KICK_HOME_URL).catch(() => []);
  const sessionCookie = cookies.find((cookie) => cookie.name === 'session_token' && cookie.value);
  if (!sessionCookie) {
    return null;
  }

  const tokenValue = decodeURIComponent(sessionCookie.value);
  const token = `Bearer ${tokenValue}`;
  const profile = await extractAuthenticatedProfile(page);
  if (!profile) {
    return null;
  }

  return {
    token,
    expiresAt: sessionCookie.expires > 0 ? new Date(sessionCookie.expires * 1000).toISOString() : null,
    profile,
    capturedAt: now()
  };
}

async function extractAuthenticatedProfile(page) {
  return page.evaluate(async ({ kickApiBaseUrl, fetchTimeoutMs }) => {
    const fetchWithTimeout = async (input, init = {}) => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), fetchTimeoutMs);

      try {
        return await fetch(input, {
          ...init,
          signal: controller.signal
        }).catch(() => null);
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    const authenticatedKey = Object.keys(localStorage).find((key) => key.includes('"authStatus":"authenticated"') && key.includes('"username":"'));
    if (!authenticatedKey) {
      return null;
    }

    const usernameMatch = authenticatedKey.match(/"username":"([^"]+)"/);
    const userIdMatch = authenticatedKey.match(/"userId":(\d+)/);
    const username = usernameMatch?.[1] ?? null;
    const userId = userIdMatch ? Number(userIdMatch[1]) : null;

    if (!username) {
      return null;
    }

    const profileResponse = await fetchWithTimeout(`${kickApiBaseUrl}/api/v2/channels/${encodeURIComponent(username)}`, {
      cache: 'no-store',
      credentials: 'include',
      headers: {
        accept: 'application/json'
      }
    });

    if (!profileResponse || !profileResponse.ok) {
      return {
        username,
        userId,
        avatarUrl: null,
        channelUrl: `https://kick.com/${username}`
      };
    }

    const payload = await profileResponse.json().catch(() => null);
    const slug = payload?.slug || username;

    return {
      username,
      userId,
      avatarUrl: payload?.user?.profile_pic || payload?.user?.profile_picture || payload?.profile_picture || null,
      channelUrl: `https://kick.com/${slug}`
    };
  }, {
    kickApiBaseUrl: KICK_API_BASE_URL,
    fetchTimeoutMs: BROWSER_FETCH_TIMEOUT_MS
  });
}

function parseFollowedChannelsPayload(payloadText) {
  const payload = JSON.parse(payloadText);
  return {
    nextCursor: payload.nextCursor ?? null,
    channels: Array.isArray(payload.channels) ? payload.channels : []
  };
}

async function fetchFollowedChannelsFromBrowser(page) {
  await ensureKickHomePage(page);
  await dismissKickConsent(page);

  const result = await page.evaluate(async ({ endpoint, maxPages, fetchTimeoutMs }) => {
    const fetchWithTimeout = async (input, init = {}) => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), fetchTimeoutMs);

      try {
        return await fetch(input, {
          ...init,
          signal: controller.signal
        }).catch(() => null);
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    const collectedChannels = [];
    const seenCursors = new Set();
    let nextCursor = null;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const query = nextCursor === null ? '' : `?cursor=${encodeURIComponent(String(nextCursor))}`;
      const response = await fetchWithTimeout(`${endpoint}${query}`, {
        cache: 'no-store',
        credentials: 'include',
        headers: {
          accept: 'application/json'
        }
      });

      if (!response) {
        return {
          ok: false,
          status: 0,
          bodySnippet: 'Background Kick request failed.'
        };
      }

      const payloadText = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          bodySnippet: payloadText.slice(0, 500)
        };
      }

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return {
          ok: false,
          status: response.status,
          bodySnippet: payloadText.slice(0, 500)
        };
      }

      if (Array.isArray(payload.channels)) {
        collectedChannels.push(...payload.channels);
      }

      const cursor = payload.nextCursor ?? null;
      if (cursor === null || seenCursors.has(String(cursor))) {
        break;
      }

      seenCursors.add(String(cursor));
      nextCursor = cursor;
    }

    return {
      ok: true,
      channels: collectedChannels
    };
  }, {
    endpoint: FOLLOWED_CHANNELS_ENDPOINT,
    maxPages: MAX_FOLLOWED_CURSOR_PAGES,
    fetchTimeoutMs: BROWSER_FETCH_TIMEOUT_MS
  });

  if (!result?.ok) {
    const securityPolicyBlocked =
      result?.status === 403 &&
      String(result?.bodySnippet || '').toLowerCase().includes('security policy');

    if (result?.status === 401 || (result?.status === 403 && !securityPolicyBlocked)) {
      throw new Error('Kick rejected the saved session. Sign in again.');
    }

    if (securityPolicyBlocked || result?.status === 0) {
      let fallbackChannels = [];

      try {
        fallbackChannels = await fetchFollowedChannelsFromDom(page);
      } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes('sign in again')) {
          throw error;
        }
      }

      if (fallbackChannels.length > 0) {
        return fallbackChannels;
      }
    }

    throw new Error(result?.bodySnippet || 'Kick browser request failed while loading followings.');
  }

  return dedupeChannels(normalizeFollowedChannels(result.channels));
}

async function fetchRecentChannelSlugsFromBrowser(page) {
  await ensureKickHomePage(page);
  await dismissKickConsent(page);

  return await page.evaluate(({ limit }) => {
    const slugPattern = /^[a-z0-9](?:[a-z0-9_-]{1,63})$/i;
    const recentChannels = new Map();

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith('viewer_engagement:')) {
        continue;
      }

      let payload = null;
      try {
        payload = JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        continue;
      }

      const channels = payload?.channels;
      if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
        continue;
      }

      for (const [rawSlug, entry] of Object.entries(channels)) {
        const channelSlug = String(rawSlug || '').trim().toLowerCase();
        if (!slugPattern.test(channelSlug)) {
          continue;
        }

        const parsedLastSeenAt = Number(entry?.lastSeenAt);
        const lastSeenAt = Number.isFinite(parsedLastSeenAt) ? parsedLastSeenAt : 0;
        const existing = recentChannels.get(channelSlug);

        if (!existing || lastSeenAt > existing.lastSeenAt) {
          recentChannels.set(channelSlug, {
            channelSlug,
            lastSeenAt
          });
        }
      }
    }

    return Array.from(recentChannels.values())
      .sort((left, right) => (right.lastSeenAt - left.lastSeenAt) || left.channelSlug.localeCompare(right.channelSlug))
      .slice(0, limit)
      .map((entry) => entry.channelSlug);
  }, {
    limit: RECENT_CHANNELS_LIMIT
  }).catch(() => []);
}

async function fetchFollowedChannelsFromDom(page) {
  const tryExtraction = async () => {
    await dismissKickConsent(page);

    const channels = await extractChannels(page, { requireFollowingContext: true }).catch(() => []);
    if (channels.length > 0) {
      return dedupeChannels(channels);
    }

    const inspection = await inspectKickPage(page);
    if (looksUnauthenticated(inspection.bodySnippet)) {
      throw new Error('Kick rejected the saved session. Sign in again.');
    }

    return [];
  };

  await ensureKickHomePage(page);

  const homeChannels = await tryExtraction();
  if (homeChannels.length > 0) {
    return homeChannels;
  }

  const openedFollowingPage = await openKickFollowingPage(page);
  if (!openedFollowingPage) {
    return [];
  }

  return await tryExtraction();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeKickNextFlightData(value) {
  if (!value.includes('self.__next_f.push')) {
    return value;
  }

  const segments = Array.from(value.matchAll(/push\(\[\d+,"([\s\S]*?)"\]\)/g))
    .map((match) => match[1]);

  if (segments.length === 0) {
    return value;
  }

  return segments
    .map((segment) => {
      try {
        return JSON.parse(`"${segment}"`);
      } catch {
        return '';
      }
    })
    .filter((segment) => segment.length > 0)
    .join('\n');
}

function findFirstNumericMatch(value, pattern) {
  const match = value.match(pattern);
  if (!match) {
    return null;
  }

  const parsedValue = Number(match[1]);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function findFirstStringMatch(value, pattern) {
  const match = value.match(pattern);
  if (!match) {
    return null;
  }

  return typeof match[1] === 'string' && match[1].length > 0
    ? match[1]
    : typeof match[0] === 'string' && match[0].length > 0
      ? match[0]
      : null;
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function selectChannelMetadataSegment(decodedHtml, channelSlug) {
  const normalizedChannelSlug = String(channelSlug || '').trim().toLowerCase();
  if (!normalizedChannelSlug || !decodedHtml) {
    return decodedHtml;
  }

  const slugPattern = new RegExp(`"slug":"${escapeRegex(normalizedChannelSlug)}"`, 'gi');
  let bestSegment = '';
  let bestScore = -1;

  for (const match of decodedHtml.matchAll(slugPattern)) {
    const start = Math.max(0, (match.index ?? 0) - 3_000);
    const end = Math.min(decodedHtml.length, (match.index ?? 0) + 12_000);
    const candidate = decodedHtml.slice(start, end);
    const score = (candidate.includes('"chatroom":{"id":') ? 100 : 0)
      + (candidate.includes('"channel_id":') ? 60 : 0)
      + (candidate.includes('"broadcaster_user_id":') ? 20 : 0)
      + (candidate.includes('"profile_pic":"') ? 10 : 0)
      + (candidate.includes('"is_live":true') ? 10 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestSegment = candidate;
    }
  }

  return bestSegment || decodedHtml;
}

function getSystemCurlCommands() {
  return process.platform === 'win32'
    ? ['curl.exe', 'curl']
    : ['curl'];
}

async function runCommandCaptureStdout(command, args) {
  await mkdir(path.join(process.cwd(), 'tmp'), { recursive: true }).catch(() => undefined);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out while fetching Kick channel HTML.`));
    }, CHANNEL_HTML_FETCH_TIMEOUT_SECONDS * 1_000 + 2_000);

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    child.once('close', (code) => {
      clearTimeout(timeoutId);

      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new Error(stderr || `${command} exited with code ${code}.`));
    });
  });
}

async function fetchKickChannelPageHtml(channelSlug) {
  const targetUrl = `https://kick.com/${encodeURIComponent(channelSlug)}`;
  let lastError = null;

  for (const command of getSystemCurlCommands()) {
    try {
      const html = await runCommandCaptureStdout(command, [
        '--max-time',
        String(CHANNEL_HTML_FETCH_TIMEOUT_SECONDS),
        '-L',
        '-sS',
        '--compressed',
        '-H',
        `User-Agent: ${DEFAULT_USER_AGENT}`,
        '-H',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        '-H',
        'Accept-Language: cs-CZ,cs;q=0.9,en;q=0.8',
        targetUrl
      ]);

      if (typeof html === 'string' && html.trim().length > 0) {
        return html;
      }

      throw new Error('Kick returned an empty HTML response.');
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') {
        break;
      }
    }
  }

  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : `Kick channel HTML fetch failed for ${channelSlug}.`
  );
}

async function fetchChannelChatMetadataFromHtml(chatRequest) {
  const html = await fetchKickChannelPageHtml(chatRequest.channelSlug);
  const decodedHtml = decodeKickNextFlightData(html);
  const metadataSegment = selectChannelMetadataSegment(decodedHtml, chatRequest.channelSlug);
  const normalizedChannelSlug = chatRequest.channelSlug;
  const slugIdPattern = new RegExp(`"id":(\\d+),"slug":"${escapeRegex(normalizedChannelSlug)}"`, 'i');

  const channelId = findFirstNumericMatch(metadataSegment, slugIdPattern)
    ?? findFirstNumericMatch(metadataSegment, /"channel_id":(\d+)/i);
  const chatroomId = findFirstNumericMatch(metadataSegment, /"chatroom":\{"id":(\d+)\}/i)
    ?? findFirstNumericMatch(metadataSegment, /"chatroom_id":(\d+)/i);

  if (channelId === null && chatroomId === null) {
    throw new Error(`Kick HTML fallback did not expose channel metadata for ${normalizedChannelSlug}.`);
  }

  const avatarUrl = findFirstStringMatch(metadataSegment, /"profile_pic":"([^"]+)"/i)
    ?? findFirstStringMatch(html, /(https:\/\/files\.kick\.com\/images\/user\/\d+\/profile_image\/[^"'\s<]+)/i)
    ?? chatRequest.avatarUrl
    ?? null;
  const avatarUserIdMatch = avatarUrl?.match(/\/images\/user\/(\d+)\//i) || null;
  const channelUserId = findFirstNumericMatch(metadataSegment, /"broadcaster_user_id":(\d+)/i)
    ?? findFirstNumericMatch(metadataSegment, /"user":\{"id":(\d+)/i)
    ?? (avatarUserIdMatch ? Number(avatarUserIdMatch[1]) : null)
    ?? chatRequest.channelUserId
    ?? null;
  const displayName = decodeBasicHtmlEntities(
    findFirstStringMatch(html, /<h1 id="channel-username">([^<]+)</i)
      ?? chatRequest.displayName
      ?? normalizedChannelSlug
  ) || normalizedChannelSlug;

  return {
    channelSlug: normalizedChannelSlug,
    channelId,
    channelUserId,
    chatroomId,
    displayName,
    channelUrl: `https://kick.com/${normalizedChannelSlug}`,
    avatarUrl,
    cursor: null,
    messages: [],
    pinnedMessage: null,
    updatedAt: new Date().toISOString()
  };
}

async function fetchChannelChatFromBrowser(page, chatRequest) {
  let metadataFallback = null;
  let metadataFallbackError = null;
  let pageSnapshot = null;
  let pageSnapshotError = null;
  let fastPathError = null;

  try {
    metadataFallback = await fetchChannelChatMetadataFromHtml(chatRequest);
  } catch (error) {
    metadataFallbackError = error;
  }

  const resolvedChannelId = metadataFallback?.channelId ?? chatRequest.channelId;
  const resolvedChannelUserId = metadataFallback?.channelUserId ?? chatRequest.channelUserId;
  const resolvedDisplayName = metadataFallback?.displayName || chatRequest.displayName;
  const resolvedAvatarUrl = metadataFallback?.avatarUrl ?? chatRequest.avatarUrl;

  if (chatRequest.fast && resolvedChannelId !== null) {
    try {
      return await fetchChannelChatFromApi(page, {
        ...chatRequest,
        channelId: resolvedChannelId,
        channelUserId: resolvedChannelUserId,
        displayName: resolvedDisplayName,
        avatarUrl: resolvedAvatarUrl
      });
    } catch (error) {
      fastPathError = error;
    }
  }

  try {
    pageSnapshot = await fetchChannelChatPageSnapshot(page, chatRequest.channelSlug);
    if (pageSnapshot.messages.length > 0) {
      return metadataFallback
        ? {
          ...pageSnapshot,
          channelId: pageSnapshot.channelId ?? metadataFallback.channelId,
          channelUserId: pageSnapshot.channelUserId ?? metadataFallback.channelUserId,
          chatroomId: pageSnapshot.chatroomId ?? metadataFallback.chatroomId,
          displayName: pageSnapshot.displayName || metadataFallback.displayName,
          channelUrl: pageSnapshot.channelUrl || metadataFallback.channelUrl,
          avatarUrl: pageSnapshot.avatarUrl || metadataFallback.avatarUrl,
          updatedAt: new Date().toISOString()
        }
        : pageSnapshot;
    }
  } catch (error) {
    pageSnapshotError = error;
  }

  try {
    const apiSnapshot = await fetchChannelChatFromApi(page, {
      ...chatRequest,
      channelId: pageSnapshot?.channelId ?? resolvedChannelId,
      channelUserId: pageSnapshot?.channelUserId ?? resolvedChannelUserId,
      displayName: pageSnapshot?.displayName || resolvedDisplayName,
      avatarUrl: pageSnapshot?.avatarUrl ?? resolvedAvatarUrl
    });

    if (!pageSnapshot && !metadataFallback) {
      return apiSnapshot;
    }

    return {
      ...apiSnapshot,
      channelId: pageSnapshot?.channelId ?? metadataFallback?.channelId ?? apiSnapshot.channelId,
      channelUserId: pageSnapshot?.channelUserId ?? metadataFallback?.channelUserId ?? apiSnapshot.channelUserId,
      chatroomId: pageSnapshot?.chatroomId ?? metadataFallback?.chatroomId ?? apiSnapshot.chatroomId,
      displayName: pageSnapshot?.displayName || metadataFallback?.displayName || apiSnapshot.displayName,
      channelUrl: pageSnapshot?.channelUrl || metadataFallback?.channelUrl || apiSnapshot.channelUrl,
      avatarUrl: pageSnapshot?.avatarUrl || metadataFallback?.avatarUrl || apiSnapshot.avatarUrl,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    if (pageSnapshot) {
      return metadataFallback
        ? {
          ...pageSnapshot,
          channelId: pageSnapshot.channelId ?? metadataFallback.channelId,
          channelUserId: pageSnapshot.channelUserId ?? metadataFallback.channelUserId,
          chatroomId: pageSnapshot.chatroomId ?? metadataFallback.chatroomId,
          displayName: pageSnapshot.displayName || metadataFallback.displayName,
          channelUrl: pageSnapshot.channelUrl || metadataFallback.channelUrl,
          avatarUrl: pageSnapshot.avatarUrl || metadataFallback.avatarUrl,
          updatedAt: new Date().toISOString()
        }
        : pageSnapshot;
    }

    if (metadataFallback) {
      return metadataFallback;
    }

    const combinedErrors = [metadataFallbackError, pageSnapshotError, fastPathError, error]
      .filter((entry) => entry instanceof Error)
      .map((entry) => entry.message.trim())
      .filter((message, index, messages) => message.length > 0 && messages.indexOf(message) === index);

    if (combinedErrors.length > 0) {
      throw new Error(combinedErrors.join(' '));
    }

    throw error;
  }
}

async function fetchChannelChatFromApi(page, chatRequest) {
  await ensureKickHomePage(page);

  const normalizedChannelSlug = chatRequest.channelSlug;

  let lastResult = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await page.evaluate(async ({ normalizedChannelSlug, kickApiBaseUrl, kickWebUrl, providedChannelId, providedChannelUserId, providedDisplayName, providedAvatarUrl, fetchTimeoutMs }) => {
      const fetchWithTimeout = async (input, init = {}) => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), fetchTimeoutMs);

        try {
          return await fetch(input, {
            ...init,
            signal: controller.signal
          }).catch(() => null);
        } finally {
          window.clearTimeout(timeoutId);
        }
      };

      const jsonHeaders = {
        accept: 'application/json'
      };

      const kickPlaceholderPattern = /\[emote:\d+:[^\]]+\]/;

      const normalizeBadgeImageUrlCandidate = (value) => {
        if (typeof value !== 'string') {
          return null;
        }

        const trimmedValue = value.trim();
        if (!trimmedValue) {
          return null;
        }

        if (!trimmedValue.startsWith('data:') && (trimmedValue.includes(',') || /\s\d+[wx](?:\s|$)/i.test(trimmedValue))) {
          const firstSrcsetEntry = trimmedValue
            .split(',')
            .map((entry) => entry.trim())
            .find((entry) => entry.length > 0);

          if (!firstSrcsetEntry) {
            return null;
          }

          const [firstUrl] = firstSrcsetEntry.split(/\s+/);
          return firstUrl || null;
        }

        return trimmedValue;
      };

      const resolveNestedBadgeImageUrl = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return null;
        }

        const candidates = [
          value?.url,
          value?.src,
          value?.srcUrl,
          value?.src_url,
          value?.original,
          value?.originalUrl,
          value?.original_url,
          value?.fullsize,
          value?.fullSize,
          value?.full_size,
          value?.srcset,
          value?.srcSet
        ];

        const match = candidates
          .map((candidate) => normalizeBadgeImageUrlCandidate(candidate))
          .find((candidate) => typeof candidate === 'string' && candidate.length > 0);

        return match || null;
      };

      const resolveBadgeImageUrl = (badge) => {
        const candidates = [
          badge?.image,
          resolveNestedBadgeImageUrl(badge?.image),
          badge?.image_url,
          badge?.badgeImage,
          badge?.badgeImageUrl,
          badge?.badge_image,
          badge?.badge_image_url,
          resolveNestedBadgeImageUrl(badge?.badgeImage),
          resolveNestedBadgeImageUrl(badge?.badge_image),
          badge?.icon,
          resolveNestedBadgeImageUrl(badge?.icon),
          badge?.icon_url,
          badge?.src,
          badge?.srcset,
          badge?.url,
          badge?.small_icon_url,
          badge?.thumbnail,
          resolveNestedBadgeImageUrl(badge?.thumbnail)
        ];

        const match = candidates
          .map((candidate) => normalizeBadgeImageUrlCandidate(candidate))
          .find((candidate) => typeof candidate === 'string' && candidate.length > 0);
        return match || null;
      };

      const normalizeBadge = (badge) => {
        if (typeof badge === 'string') {
          const typeMatch = badge.match(/type=([^;}]*)/i);
          const textMatch = badge.match(/text=([^;}]*)/i);
          const countMatch = badge.match(/count=([^;}]*)/i);
          const imageMatch = badge.match(/(?:imageUrl|image_url|image|iconUrl|icon|icon_url|src|srcset|url|badgeImageUrl|badge_image_url|badgeUrl|badge_url|original|originalUrl|original_url|fullsize|fullSize|full_size)=([^;}]*)/i);
          const parsedCount = Number(countMatch?.[1]);
          const type = typeMatch?.[1]?.trim() || '';
          const text = textMatch?.[1]?.trim() || type;

          if (!type && !text) {
            return null;
          }

          return {
            type,
            text,
            count: Number.isFinite(parsedCount) ? parsedCount : null,
            imageUrl: normalizeBadgeImageUrlCandidate(imageMatch?.[1] ?? null)
          };
        }

        if (!badge || typeof badge !== 'object') {
          return null;
        }

        const parsedCount = Number(badge?.count);
        const type = typeof badge?.type === 'string' ? badge.type : '';
        const text = typeof badge?.text === 'string' ? badge.text : type;

        if (!type && !text) {
          return null;
        }

        return {
          type,
          text,
          count: Number.isFinite(parsedCount) ? parsedCount : null,
          imageUrl: resolveBadgeImageUrl(badge)
        };
      };

      const resolveMessageContent = (message) => {
        const metadata = message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
          ? message.metadata
          : null;
        const candidates = [
          typeof message?.content === 'string' ? message.content : '',
          typeof message?.original_message === 'string' ? message.original_message : '',
          typeof message?.body === 'string' ? message.body : '',
          typeof message?.message === 'string' ? message.message : '',
          typeof message?.text === 'string' ? message.text : '',
          typeof metadata?.original_message === 'string' ? metadata.original_message : '',
          typeof metadata?.body === 'string' ? metadata.body : '',
          typeof metadata?.text === 'string' ? metadata.text : ''
        ].filter((candidate) => candidate.length > 0);

        const kickPlaceholderCandidate = candidates.find((candidate) => kickPlaceholderPattern.test(candidate));
        if (kickPlaceholderCandidate) {
          return kickPlaceholderCandidate;
        }

        return candidates.sort((left, right) => right.length - left.length)[0] || '';
      };

      const normalizeBadges = (value) => {
        if (!Array.isArray(value)) {
          return [];
        }

        return value
          .map((badge) => normalizeBadge(badge))
          .filter(Boolean);
      };

      const normalizeMessage = (message) => {
        if (!message || typeof message !== 'object') {
          return null;
        }

        return {
          id: String(message.id || ''),
          content: resolveMessageContent(message),
          type: typeof message.type === 'string' ? message.type : 'message',
          createdAt: typeof message.created_at === 'string' ? message.created_at : null,
          threadParentId: typeof message.thread_parent_id === 'string' ? message.thread_parent_id : null,
          sender: {
            id: Number.isFinite(Number(message.sender?.id)) ? Number(message.sender.id) : null,
            username: typeof message.sender?.username === 'string' ? message.sender.username : 'unknown',
            slug: typeof message.sender?.slug === 'string'
              ? message.sender.slug
              : typeof message.sender?.username === 'string'
                ? message.sender.username
                : 'unknown',
            color: typeof message.sender?.identity?.color === 'string' ? message.sender.identity.color : null,
            badges: normalizeBadges(message.sender?.identity?.badges)
          }
        };
      };

      let channelPayload = null;
      let channelId = Number.isFinite(Number(providedChannelId)) ? Number(providedChannelId) : null;

      if (channelId === null) {
        const channelResponse = await fetchWithTimeout(`${kickApiBaseUrl}/api/v2/channels/${encodeURIComponent(normalizedChannelSlug)}`, {
          cache: 'no-store',
          credentials: 'include',
          headers: jsonHeaders
        });

        if (!channelResponse) {
          return {
            ok: false,
            status: 0,
            bodySnippet: 'Background Kick channel request failed.'
          };
        }

        const channelPayloadText = await channelResponse.text();
        if (!channelResponse.ok) {
          return {
            ok: false,
            status: channelResponse.status,
            bodySnippet: channelPayloadText.slice(0, 500)
          };
        }

        try {
          channelPayload = JSON.parse(channelPayloadText);
        } catch {
          return {
            ok: false,
            status: channelResponse.status,
            bodySnippet: channelPayloadText.slice(0, 500)
          };
        }

        channelId =
          channelPayload?.id ||
          channelPayload?.chatroom?.channel_id ||
          channelPayload?.chatroom?.id ||
          null;
      }

      if (!channelId) {
        return {
          ok: false,
          status: 500,
          bodySnippet: `Kick did not return a chat id for ${normalizedChannelSlug}.`
        };
      }

      const historyUrl = new URL(`${kickWebUrl}/api/v1/chat/${encodeURIComponent(String(channelId))}/history`);
      historyUrl.searchParams.set('_cb', String(Date.now()));

      const historyResponse = await fetchWithTimeout(historyUrl.toString(), {
        cache: 'no-store',
        credentials: 'include',
        headers: jsonHeaders
      });

      let historyPayload = null;
      let historyData = null;
      let messages = [];
      let pinnedMessage = null;
      let cursor = null;
      let historyFailure = null;

      if (historyResponse && historyResponse.ok) {
        const historyPayloadText = await historyResponse.text();

        try {
          historyPayload = JSON.parse(historyPayloadText);
          historyData = historyPayload?.data && typeof historyPayload.data === 'object'
            ? historyPayload.data
            : historyPayload;
          messages = Array.isArray(historyData?.messages)
            ? historyData.messages.map(normalizeMessage).filter(Boolean)
            : [];
          pinnedMessage = normalizeMessage(historyData?.pinned_message?.message || historyPayload?.pinned_message?.message || null);
          cursor = typeof historyData?.cursor === 'string' ? historyData.cursor : null;
        } catch {
          historyPayload = null;
          historyData = null;
          historyFailure = {
            status: historyResponse.status,
            bodySnippet: historyPayloadText.slice(0, 500)
          };
        }
      } else if (historyResponse) {
        const historyPayloadText = await historyResponse.text().catch(() => '');
        historyFailure = {
          status: historyResponse.status,
          bodySnippet: historyPayloadText.slice(0, 500)
        };
      } else {
        historyFailure = {
          status: 0,
          bodySnippet: 'Kick chat history request failed.'
        };
      }

      const resolvedChatroomId =
        historyData?.chatroom_id ||
        historyPayload?.chatroom_id ||
        channelPayload?.chatroom?.id ||
        channelPayload?.livestream?.chatroom_id ||
        null;
      const resolvedChannelSlug = typeof channelPayload?.slug === 'string' ? channelPayload.slug : normalizedChannelSlug;

      if (historyFailure && resolvedChatroomId === null) {
        return {
          ok: false,
          status: historyFailure.status,
          bodySnippet: historyFailure.bodySnippet || `Kick did not return chat history for ${resolvedChannelSlug}.`
        };
      }

      return {
        ok: true,
        chat: {
          channelSlug: resolvedChannelSlug,
          channelId: Number(channelId),
          channelUserId: Number.isFinite(Number(channelPayload?.user?.id))
            ? Number(channelPayload.user.id)
            : Number.isFinite(Number(providedChannelUserId))
              ? Number(providedChannelUserId)
              : null,
          chatroomId: resolvedChatroomId !== null ? Number(resolvedChatroomId) : null,
          displayName: typeof channelPayload?.user?.username === 'string'
            ? channelPayload.user.username
            : (typeof providedDisplayName === 'string' && providedDisplayName.length > 0 ? providedDisplayName : resolvedChannelSlug),
          channelUrl: `https://kick.com/${resolvedChannelSlug}`,
          avatarUrl:
            channelPayload?.user?.profile_pic ||
            channelPayload?.user?.profile_picture ||
            channelPayload?.profile_picture ||
            (typeof providedAvatarUrl === 'string' && providedAvatarUrl.length > 0 ? providedAvatarUrl : null),
          cursor,
          messages,
          pinnedMessage,
          updatedAt: new Date().toISOString()
        }
      };
    }, {
      normalizedChannelSlug,
      kickApiBaseUrl: KICK_API_BASE_URL,
      kickWebUrl: KICK_WEB_URL,
      providedChannelId: chatRequest.channelId,
      providedChannelUserId: chatRequest.channelUserId,
      providedDisplayName: chatRequest.displayName,
      providedAvatarUrl: chatRequest.avatarUrl,
      fetchTimeoutMs: BROWSER_FETCH_TIMEOUT_MS
    });

    if (result?.ok) {
      return result.chat;
    }

    lastResult = result;

    const securityPolicyBlocked =
      result?.status === 403 &&
      String(result?.bodySnippet || '').toLowerCase().includes('security policy');

    if (!securityPolicyBlocked || attempt === 2) {
      break;
    }

    await ensureKickHomePage(page);
    await page.waitForTimeout(BACKGROUND_FETCH_WARMUP_MS * (attempt + 1));
  }

  if (lastResult?.status === 401 || (lastResult?.status === 403 && !String(lastResult?.bodySnippet || '').toLowerCase().includes('security policy'))) {
    throw new Error('Kick rejected the saved session. Sign in again.');
  }

  if (lastResult?.status === 404) {
    throw new Error(`Kick could not find chat for channel ${normalizedChannelSlug}.`);
  }

  throw new Error(lastResult?.bodySnippet || `Kick browser request failed while loading chat for ${normalizedChannelSlug}.`);
}

async function fetchChannelChatPageSnapshot(page, channelSlug) {
  await openKickChannelPage(page, channelSlug);

  await dismissKickConsent(page);

  const chatTab = page.getByText(/^Chat$/).last();
  if (await chatTab.isVisible().catch(() => false)) {
    await chatTab.click().catch(() => undefined);
  }

  await page.waitForTimeout(CHANNEL_CHAT_DOM_WARMUP_MS);

  const snapshot = await page.evaluate((normalizedChannelSlug) => {
    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const slugPattern = new RegExp(`"slug":"${escapeRegex(normalizedChannelSlug)}"`);

    const decodeNextDataScript = (value) => {
      if (!value.includes('self.__next_f.push')) {
        return value;
      }

      const segments = Array.from(value.matchAll(/push\(\[\d+,"([\s\S]*?)"\]\)/g))
        .map((match) => match[1]);
      if (segments.length === 0) {
        return value;
      }

      return segments
        .map((segment) => {
          try {
            return JSON.parse(`"${segment}"`);
          } catch {
            return '';
          }
        })
        .filter((segment) => segment.length > 0)
        .join('\n');
    };

    const dataBlob = Array.from(document.querySelectorAll('script'))
      .map((script) => script.textContent || '')
      .map((text) => decodeNextDataScript(text))
      .filter((text) => text.length > 0 && slugPattern.test(text) && text.includes('"chatroom":{"id":'))
      .sort((left, right) => right.length - left.length)[0] || '';

    const findNumericMatch = (pattern) => {
      const match = dataBlob.match(pattern);
      if (!match) {
        return null;
      }

      const parsedValue = Number(match[1]);
      return Number.isFinite(parsedValue) ? parsedValue : null;
    };

    const channelId = findNumericMatch(new RegExp(`"id":(\\d+),"slug":"${escapeRegex(normalizedChannelSlug)}"`))
      ?? findNumericMatch(/"channel_id":(\d+)/);
    const chatroomId = findNumericMatch(/"chatroom":\{"id":(\d+)\}/);
    const avatarMatch = dataBlob.match(/"profile_pic":"([^"]+)"/);
    const titleMatch = document.title.match(/^(.*?)\s+Stream\s+-\s+Watch Live on Kick$/i);
    const avatarImage = Array.from(document.images)
      .find((image) => {
        const imageUrl = image.currentSrc || image.src || '';
        const alt = normalizeText(image.alt || '');
        return alt.toLowerCase() === normalizedChannelSlug || /\/images\/user\/\d+\//.test(imageUrl);
      }) || null;
    const avatarUrl = avatarMatch?.[1] || avatarImage?.currentSrc || avatarImage?.src || null;
    const avatarUserIdMatch = avatarUrl?.match(/\/images\/user\/(\d+)\//) || null;
    const channelUserId = avatarUserIdMatch ? Number(avatarUserIdMatch[1]) : null;
    const displayName = normalizeText(
      titleMatch?.[1] ||
      avatarImage?.getAttribute('alt') ||
      normalizedChannelSlug
    ) || normalizedChannelSlug;

    const resolveBadgeType = (...candidates) => {
      const normalizedCandidate = candidates
        .map((candidate) => normalizeText(candidate).toLowerCase())
        .find((candidate) => candidate.length > 0) || '';

      if (normalizedCandidate.includes('moderator')) {
        return 'moderator';
      }

      if (normalizedCandidate.includes('verified')) {
        return 'verified';
      }

      if (normalizedCandidate.includes('vip')) {
        return 'vip';
      }

      if (normalizedCandidate.includes('founder')) {
        return 'founder';
      }

      if (normalizedCandidate.includes('subscriber')) {
        return 'subscriber';
      }

      if (normalizedCandidate.includes('gift')) {
        return 'sub_gifter';
      }

      if (normalizedCandidate.includes('og')) {
        return 'og';
      }

      return normalizedCandidate.replace(/\s+/g, '-') || 'badge';
    };

    const readBadgeCount = (value) => {
      const subscriberMatch = normalizeText(value).match(/(\d+)\s*-\s*Month Subscriber/i);
      if (!subscriberMatch) {
        return null;
      }

      const parsedCount = Number(subscriberMatch[1]);
      return Number.isFinite(parsedCount) ? parsedCount : null;
    };

    const extractElementLabel = (element) => normalizeText(
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.querySelector('title')?.textContent ||
      element.closest('[aria-label]')?.getAttribute('aria-label') ||
      element.closest('[title]')?.getAttribute('title') ||
      element.parentElement?.getAttribute('aria-label') ||
      element.parentElement?.getAttribute('title') ||
      ''
    );

    const extractStyleImageUrl = (element) => {
      const styleValues = [];
      if (element instanceof HTMLElement) {
        styleValues.push(element.style.backgroundImage, element.style.maskImage, element.style.webkitMaskImage);
      }

      const computedStyle = getComputedStyle(element);
      styleValues.push(computedStyle.backgroundImage, computedStyle.maskImage, computedStyle.webkitMaskImage);

      for (const styleValue of styleValues) {
        const urlMatch = String(styleValue || '').match(/url\(["']?([^"')]+)["']?\)/i);
        if (urlMatch?.[1]) {
          return urlMatch[1];
        }
      }

      return null;
    };

    const createSvgDataUrl = (svgElement) => {
      const outerMarkup = svgElement.outerHTML || '';
      if (!outerMarkup) {
        return null;
      }

      const svgMarkup = outerMarkup.includes('xmlns=')
        ? outerMarkup
        : outerMarkup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svgMarkup)}`;
    };

    const parseBadgeElement = (element) => {
      const label = extractElementLabel(element);
      const count = readBadgeCount(label);
      const className = typeof element.getAttribute('class') === 'string' ? element.getAttribute('class') : '';

      let imageUrl = null;
      if (element instanceof HTMLImageElement) {
        imageUrl = element.currentSrc || element.getAttribute('src') || null;
      } else if (element instanceof SVGElement) {
        imageUrl = createSvgDataUrl(element);
      } else {
        imageUrl = extractStyleImageUrl(element);
      }

      if (!label && !imageUrl) {
        return null;
      }

      const type = count !== null ? 'subscriber' : resolveBadgeType(label, className);
      const text = label || type;

      return {
        type,
        text,
        count,
        imageUrl
      };
    };

    const collectBadgeElements = (senderContainer, senderButton) => {
      if (!senderContainer) {
        return [];
      }

      const badgeElements = [];
      const seenBadgeElements = new Set();

      const pushBadgeElement = (element) => {
        if (!(element instanceof Element) || senderButton.contains(element) || seenBadgeElements.has(element)) {
          return;
        }

        seenBadgeElements.add(element);
        badgeElements.push(element);
      };

      for (const candidate of Array.from(senderContainer.querySelectorAll('img, svg'))) {
        pushBadgeElement(candidate);
      }

      for (const candidate of Array.from(senderContainer.querySelectorAll('*'))) {
        if (candidate instanceof Element && extractStyleImageUrl(candidate)) {
          pushBadgeElement(candidate);
        }
      }

      return badgeElements;
    };

    const parseTimestampToIso = (value) => {
      const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})\s*([AP]M)?$/i);
      if (!match) {
        return null;
      }

      let hours = Number(match[1]);
      const minutes = Number(match[2]);
      const meridiem = match[3]?.toUpperCase() || null;

      if (meridiem === 'PM' && hours < 12) {
        hours += 12;
      } else if (meridiem === 'AM' && hours === 12) {
        hours = 0;
      }

      const now = new Date();
      const timestamp = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hours,
        minutes,
        0,
        0
      );

      if (timestamp.getTime() - now.getTime() > 5 * 60 * 1000) {
        timestamp.setDate(timestamp.getDate() - 1);
      }

      return timestamp.toISOString();
    };

    const serializeMessageBody = (node) => {
      const segments = [];

      const pushText = (value) => {
        if (!value) {
          return;
        }

        segments.push(value);
      };

      const walk = (currentNode) => {
        if (!currentNode) {
          return;
        }

        if (currentNode.nodeType === Node.TEXT_NODE) {
          pushText(currentNode.textContent || '');
          return;
        }

        if (!(currentNode instanceof Element)) {
          return;
        }

        const emoteId = currentNode.getAttribute('data-emote-id');
        const emoteName = normalizeText(currentNode.getAttribute('data-emote-name') || '');
        if (emoteId && emoteName) {
          segments.push(`[emote:${emoteId}:${emoteName}]`);
          return;
        }

        if (currentNode instanceof HTMLImageElement) {
          const alt = normalizeText(currentNode.alt || currentNode.title || '');
          const imageUrl = currentNode.currentSrc || currentNode.src || '';
          const emoteMatch = imageUrl.match(/\/emotes\/(\d+)\//i);

          if (emoteMatch && alt) {
            segments.push(`[emote:${emoteMatch[1]}:${alt}]`);
            return;
          }

          if (alt) {
            segments.push(alt);
            return;
          }
        }

        for (const childNode of Array.from(currentNode.childNodes)) {
          walk(childNode);
        }
      };

      walk(node);
      return normalizeText(segments.join(''));
    };

    const messages = [];
    const seenMessageIds = new Set();
    const senderButtons = Array.from(document.querySelectorAll('button[data-prevent-expand="true"]'));

    for (const senderButton of senderButtons) {
      if (!(senderButton instanceof HTMLElement)) {
        continue;
      }

      const username = normalizeText(senderButton.textContent || '');
      if (!username) {
        continue;
      }

      const messageRoot = senderButton.closest('div[class*="rounded-lg"]') || senderButton.closest('article, li, section, div');
      if (!(messageRoot instanceof HTMLElement)) {
        continue;
      }

      const separator = Array.from(messageRoot.querySelectorAll('span[aria-hidden="true"]'))
        .find((element) => normalizeText(element.textContent || '').startsWith(':'));
      const bodyNode = separator?.nextElementSibling;
      if (!(bodyNode instanceof HTMLElement)) {
        continue;
      }

      const content = serializeMessageBody(bodyNode);
      const timestamp = normalizeText(messageRoot.querySelector('span.text-neutral')?.textContent || '');
      const senderContainer = senderButton.parentElement;
      const badges = senderContainer
        ? collectBadgeElements(senderContainer, senderButton)
          .map((element) => parseBadgeElement(element))
          .filter(Boolean)
        : [];
      const senderColor = senderButton.style.color || getComputedStyle(senderButton).color || null;
      const messageId = `dom:${timestamp}:${username}:${content || 'empty'}`;

      if (seenMessageIds.has(messageId)) {
        continue;
      }

      seenMessageIds.add(messageId);
      messages.push({
        id: messageId,
        content,
        type: 'message',
        createdAt: parseTimestampToIso(timestamp),
        threadParentId: null,
        sender: {
          id: null,
          username,
          slug: username.toLowerCase(),
          color: senderColor || null,
          badges
        }
      });
    }

    return {
      ok: channelId !== null || chatroomId !== null || messages.length > 0,
      channelSlug: normalizedChannelSlug,
      channelId,
      channelUserId,
      chatroomId,
      displayName,
      channelUrl: `https://kick.com/${normalizedChannelSlug}`,
      avatarUrl,
      cursor: null,
      messages: messages.slice(-100),
      pinnedMessage: null,
      bodySnippet: normalizeText((document.body?.innerText || '').slice(0, 500))
    };
  }, channelSlug);

  if (!snapshot?.ok) {
    throw new Error(snapshot?.bodySnippet || `Kick did not expose chat data for ${channelSlug}.`);
  }

  return {
    channelSlug: snapshot.channelSlug,
    channelId: snapshot.channelId,
    channelUserId: snapshot.channelUserId,
    chatroomId: snapshot.chatroomId,
    displayName: snapshot.displayName,
    channelUrl: snapshot.channelUrl,
    avatarUrl: snapshot.avatarUrl,
    cursor: snapshot.cursor,
    messages: snapshot.messages,
    pinnedMessage: snapshot.pinnedMessage,
    updatedAt: new Date().toISOString()
  };
}

async function openKickChannelPage(page, channelSlug) {
  const targetUrl = `https://kick.com/${encodeURIComponent(channelSlug)}`;
  let lastSnippet = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    }).catch(() => undefined);
    await page.waitForTimeout(BACKGROUND_FETCH_WARMUP_MS);

    const inspection = await page.evaluate(() => ({
      title: document.title || '',
      bodySnippet: (document.body?.innerText || '').slice(0, 500)
    })).catch(() => ({ title: '', bodySnippet: '' }));

    lastSnippet = inspection.bodySnippet || inspection.title || lastSnippet;

    if (!looksSecurityBlocked(lastSnippet)) {
      return;
    }

    await ensureKickHomePage(page);
  }

  throw new Error(lastSnippet || `Kick returned a security policy block while opening ${channelSlug}.`);
}

async function dismissKickConsent(page) {
  const acceptAllButton = page.getByRole('button', { name: /accept all/i }).first();
  if (await acceptAllButton.isVisible().catch(() => false)) {
    await acceptAllButton.click().catch(() => undefined);
    await page.waitForTimeout(250).catch(() => undefined);
  }
}

async function inspectKickPage(page) {
  return page.evaluate(() => ({
    title: document.title || '',
    bodySnippet: (document.body?.innerText || '').slice(0, 500),
    pathname: window.location.pathname || '/'
  })).catch(() => ({
    title: '',
    bodySnippet: '',
    pathname: '/'
  }));
}

async function openKickFollowingPage(page) {
  await ensureKickHomePage(page);
  await dismissKickConsent(page);

  const clickedFollowingLink = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const followingLink = Array.from(document.querySelectorAll('a[href], button'))
      .find((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }

        const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') || '' : '';
        const label = normalize(
          element.getAttribute('aria-label')
            || element.getAttribute('title')
            || element.textContent
            || ''
        );

        return /\/following(?:\/|$)/i.test(href) || label === 'following' || label.startsWith('following ');
      });

    if (!followingLink) {
      return false;
    }

    followingLink.click();
    return true;
  }).catch(() => false);

  if (clickedFollowingLink) {
    await page.waitForTimeout(BACKGROUND_FETCH_WARMUP_MS * 2).catch(() => undefined);
    const inspection = await inspectKickPage(page);
    if (!looksKickNotFound(inspection.bodySnippet) && !looksSecurityBlocked(inspection.bodySnippet)) {
      return true;
    }

    await ensureKickHomePage(page);
  }

  await page.goto(`${KICK_API_BASE_URL}/following`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  }).catch(() => undefined);
  await page.waitForTimeout(BACKGROUND_FETCH_WARMUP_MS * 2).catch(() => undefined);

  const inspection = await inspectKickPage(page);
  return !looksKickNotFound(inspection.bodySnippet) && !looksSecurityBlocked(inspection.bodySnippet);
}

async function ensureKickHomePage(page) {
  const currentUrl = typeof page.url === 'function' ? page.url() : '';
  if (isKickHomePageUrl(currentUrl)) {
    return;
  }

  await page.goto(KICK_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  }).catch(() => undefined);
  await page.waitForTimeout(BACKGROUND_FETCH_WARMUP_MS);
}

function isKickHomePageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://kick.com' && (url.pathname === '/' || url.pathname === '');
  } catch {
    return false;
  }
}

function looksKickNotFound(pageText) {
  const normalized = (pageText || '').toLowerCase();
  return normalized.includes("we can't find the page you're looking for") || normalized.includes('oops, something went wrong');
}

async function readKickSession(filePath) {
  const storedSession = await readJson(filePath, null);
  if (!storedSession || typeof storedSession !== 'object') {
    return null;
  }

  return storedSession;
}

function hasValidKickSession(session) {
  if (!session?.token || !session?.profile?.username) {
    return false;
  }

  if (!session.expiresAt) {
    return true;
  }

  const expirationTime = Date.parse(session.expiresAt);
  return Number.isNaN(expirationTime) || expirationTime > Date.now();
}

async function invalidateSavedSession(sessionFile, cookieFile) {
  await rm(sessionFile, { force: true }).catch(() => undefined);
  await rm(cookieFile, { force: true }).catch(() => undefined);
}

function normalizeChannelTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return [...new Set(tags
    .map((tag) => {
      if (typeof tag === 'string') {
        return tag.trim();
      }

      if (tag && typeof tag === 'object' && typeof tag.name === 'string') {
        return tag.name.trim();
      }

      return '';
    })
    .filter((tag) => tag.length > 0))];
}

function resolveChannelThumbnailUrl(channel) {
  return channel.profile_picture
    || channel.user?.profile_pic
    || channel.user?.profile_picture
    || channel.thumbnail?.url
    || channel.thumbnail
    || channel.stream?.thumbnail
    || channel.livestream?.thumbnail
    || null;
}

function normalizeFollowedChannels(channels) {
  return channels.map((channel) => {
    const channelSlug = String(channel.channel_slug || channel.user_username || channel.slug || '').trim().toLowerCase();
    const displayName = String(
      channel.user?.username
      || channel.user?.name
      || channel.display_name
      || channel.user_username
      || channel.channel_slug
      || channel.slug
      || channelSlug
    ).trim() || 'unknown';
    const parsedViewerCount = parseOptionalNumber(
      channel.viewer_count
      ?? channel.stream?.viewer_count
      ?? channel.livestream?.viewer_count
      ?? null
    );

    return {
      channelSlug,
      displayName,
      isLive: channel.is_live === true || channel.isLive === true || channel.stream?.is_live === true || channel.livestream?.is_live === true,
      thumbnailUrl: resolveChannelThumbnailUrl(channel),
      channelUrl: `https://kick.com/${channelSlug}`,
      chatUrl: `https://kick.com/${channelSlug}`,
      broadcasterUserId: parseOptionalNumber(channel.broadcaster_user_id ?? channel.user_id ?? channel.user?.id ?? null),
      channelId: parseOptionalNumber(channel.channel_id ?? channel.id ?? channel.chatroom?.channel_id ?? channel.livestream?.channel_id ?? null),
      chatroomId: parseOptionalNumber(channel.chatroom_id ?? channel.chatroom?.id ?? channel.livestream?.chatroom_id ?? null),
      viewerCount: parsedViewerCount !== null ? Math.round(parsedViewerCount) : null,
      streamTitle: typeof (channel.session_title ?? channel.stream_title ?? channel.livestream?.session_title) === 'string'
        ? (channel.session_title ?? channel.stream_title ?? channel.livestream?.session_title).trim() || null
        : null,
      categoryName: typeof (channel.category?.name ?? channel.recent_categories?.[0]?.name ?? channel.livestream?.categories?.[0]?.name) === 'string'
        ? (channel.category?.name ?? channel.recent_categories?.[0]?.name ?? channel.livestream?.categories?.[0]?.name).trim() || null
        : null,
      tags: normalizeChannelTags(channel.custom_tags ?? channel.tags ?? channel.stream?.custom_tags ?? channel.livestream?.tags ?? [])
    };
  }).filter((channel) => channel.channelSlug && channel.isLive);
}

function scoreFollowedChannel(channel) {
  return (channel.isLive ? 100 : 0)
    + (channel.chatroomId !== null ? 40 : 0)
    + (channel.channelId !== null ? 30 : 0)
    + (channel.broadcasterUserId !== null ? 20 : 0)
    + (channel.viewerCount !== null ? 10 : 0)
    + (channel.thumbnailUrl ? 5 : 0)
    + (channel.streamTitle ? 3 : 0)
    + (channel.categoryName ? 2 : 0)
    + Math.min(channel.tags.length, 5);
}

function dedupeChannels(channels) {
  const deduped = new Map();

  for (const channel of channels) {
    const existing = deduped.get(channel.channelSlug);
    if (!existing || scoreFollowedChannel(channel) > scoreFollowedChannel(existing)) {
      deduped.set(channel.channelSlug, channel);
    }
  }

  return Array.from(deduped.values());
}

async function extractChannels(page, options = {}) {
  return page.evaluate(({ reservedValues, requireFollowingContext }) => {
    const reservedPaths = new Set(reservedValues);
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const currentPathHasFollowingContext = /\/following(?:\/|$)/i.test(window.location.pathname || '/');
    const toFiniteNumber = (value) => {
      const parsedValue = Number(value);
      return Number.isFinite(parsedValue) ? parsedValue : null;
    };
    const normalizeTags = (value) => {
      if (!Array.isArray(value)) {
        return [];
      }

      return [...new Set(value
        .map((entry) => {
          if (typeof entry === 'string') {
            return normalize(entry);
          }

          if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
            return normalize(entry.name);
          }

          return '';
        })
        .filter((entry) => entry.length > 0))];
    };
    const decodeNextDataScript = (value) => {
      if (!value.includes('self.__next_f.push')) {
        return value;
      }

      const segments = Array.from(value.matchAll(/push\(\[\d+,"([\s\S]*?)"\]\)/g))
        .map((match) => match[1]);
      if (segments.length === 0) {
        return value;
      }

      return segments
        .map((segment) => {
          try {
            return JSON.parse(`"${segment}"`);
          } catch {
            return '';
          }
        })
        .filter((segment) => segment.length > 0)
        .join('\n');
    };
    const candidates = new Map();

    const addCandidate = (candidate) => {
      const slug = normalize(candidate.channelSlug).toLowerCase();
      if (!slug || reservedPaths.has(slug)) {
        return;
      }

      const existing = candidates.get(slug);
      if (existing && existing.score >= candidate.score) {
        return;
      }

      candidates.set(slug, {
        ...candidate,
        channelSlug: slug,
        displayName: normalize(candidate.displayName) || slug,
        channelUrl: `https://kick.com/${slug}`,
        chatUrl: `https://kick.com/${slug}`,
        tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag) => normalize(tag).length > 0) : []
      });
    };

    const walk = (value, path = []) => {
      if (!value) {
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, path);
        }
        return;
      }

      if (typeof value !== 'object') {
        return;
      }

      const objectValue = value;
      const hasFollowingContext = currentPathHasFollowingContext || path.some((segment) => /follow(?:ing|ed)/i.test(String(segment || '')));
      const slug =
        objectValue.slug ||
        objectValue.channel_slug ||
        objectValue.username ||
        objectValue.channel ||
        objectValue.user?.username ||
        objectValue.broadcaster?.username;
      const isLive =
        objectValue.is_live === true ||
        objectValue.isLive === true ||
        objectValue.livestream?.is_live === true ||
        objectValue.livestream?.isLive === true ||
        objectValue.stream?.is_live === true ||
        objectValue.stream?.isLive === true ||
        objectValue.broadcast?.isLive === true;

      if (slug && isLive) {
        const channelId =
          toFiniteNumber(objectValue.channel_id)
          ?? toFiniteNumber(objectValue.livestream?.channel_id)
          ?? toFiniteNumber(objectValue.chatroom?.channel_id)
          ?? toFiniteNumber(objectValue.id);
        const chatroomId =
          toFiniteNumber(objectValue.chatroom_id)
          ?? toFiniteNumber(objectValue.chatroom?.id)
          ?? toFiniteNumber(objectValue.livestream?.chatroom_id);
        const broadcasterUserId =
          toFiniteNumber(objectValue.broadcaster_user_id)
          ?? toFiniteNumber(objectValue.user_id)
          ?? toFiniteNumber(objectValue.user?.id)
          ?? toFiniteNumber(objectValue.broadcaster?.id);
        const viewerCount =
          toFiniteNumber(objectValue.viewer_count)
          ?? toFiniteNumber(objectValue.stream?.viewer_count)
          ?? toFiniteNumber(objectValue.livestream?.viewer_count)
          ?? toFiniteNumber(objectValue.broadcast?.viewer_count);

        addCandidate({
          channelSlug: slug,
          displayName:
            objectValue.display_name ||
            objectValue.displayName ||
            objectValue.name ||
            objectValue.user?.username ||
            objectValue.user?.name ||
            slug,
          thumbnailUrl:
            objectValue.thumbnail?.url ||
            objectValue.user?.profile_pic ||
            objectValue.user?.profile_picture ||
            objectValue.user?.profilePicture ||
            objectValue.profile_picture ||
            objectValue.thumbnail ||
            null,
          broadcasterUserId,
          channelId,
          chatroomId,
          viewerCount: viewerCount !== null ? Math.round(viewerCount) : null,
          streamTitle: normalize(
            objectValue.stream_title ||
            objectValue.session_title ||
            objectValue.stream?.stream_title ||
            objectValue.livestream?.stream_title ||
            objectValue.livestream?.session_title ||
            ''
          ) || null,
          categoryName: normalize(
            objectValue.category?.name ||
            objectValue.categories?.[0]?.name ||
            objectValue.recent_categories?.[0]?.name ||
            objectValue.livestream?.category?.name ||
            objectValue.livestream?.categories?.[0]?.name ||
            ''
          ) || null,
          tags: normalizeTags(
            objectValue.custom_tags
            || objectValue.tags
            || objectValue.stream?.custom_tags
            || objectValue.stream?.tags
            || objectValue.livestream?.custom_tags
            || objectValue.livestream?.tags
            || []
          ),
          isLive: true,
          fromFollowingContext: hasFollowingContext,
          score: 100
            + (hasFollowingContext ? 200 : 0)
            + (chatroomId !== null ? 40 : 0)
            + (channelId !== null ? 30 : 0)
            + (broadcasterUserId !== null ? 20 : 0)
            + (viewerCount !== null ? 10 : 0)
        });
      }

      for (const [key, nestedValue] of Object.entries(objectValue)) {
        walk(nestedValue, [...path, key]);
      }
    };

    for (const script of Array.from(document.querySelectorAll('script'))) {
      const content = decodeNextDataScript(script.textContent?.trim() || '');
      if (!content || content.length < 2 || content.length > 2_000_000) {
        continue;
      }

      if (!(content.startsWith('{') || content.startsWith('['))) {
        continue;
      }

      try {
        walk(JSON.parse(content), ['script']);
      } catch {
        // Ignore non-JSON script blocks.
      }
    }

    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = anchor.getAttribute('href') || '';

      if (!href.startsWith('/')) {
        continue;
      }

      const segments = href.split('/').filter(Boolean);
      if (segments.length !== 1) {
        continue;
      }

      const slug = normalize(segments[0]).toLowerCase();
      if (!slug || reservedPaths.has(slug)) {
        continue;
      }

      const container = anchor.closest('article, li, section, div') || anchor;
      const blob = normalize(`${container.textContent || ''} ${anchor.textContent || ''}`);
      const isLive = /\blive\b/i.test(blob);
      const hasFollowingContext = currentPathHasFollowingContext || /\bfollow(?:ing|ed)\b/i.test(blob);
      if (!isLive) {
        continue;
      }

      addCandidate({
        channelSlug: slug,
        displayName: normalize(anchor.getAttribute('aria-label') || anchor.textContent || slug),
        isLive: true,
        thumbnailUrl: anchor.querySelector('img')?.getAttribute('src') || null,
        fromFollowingContext: hasFollowingContext,
        score: 50
          + (hasFollowingContext ? 200 : 0)
          + (anchor.querySelector('img') ? 15 : 0)
          + Math.min(blob.length, 25)
      });
    }

    const resolvedCandidates = Array.from(candidates.values())
      .sort((left, right) => right.score - left.score)
    const followingCandidates = resolvedCandidates.filter((candidate) => candidate.fromFollowingContext);
    const preferredCandidates = followingCandidates.length > 0
      ? followingCandidates
      : requireFollowingContext
        ? []
        : resolvedCandidates;

    return preferredCandidates.map(({ score, fromFollowingContext, ...candidate }) => candidate);
  }, {
    reservedValues: Array.from(RESERVED_PATHS),
    requireFollowingContext: options.requireFollowingContext === true
  });
}

function looksUnauthenticated(pageText) {
  const normalized = (pageText || '').toLowerCase();
  return normalized.includes('log in') && normalized.includes('sign up');
}

function looksSecurityBlocked(pageText) {
  const normalized = (pageText || '').toLowerCase();
  return normalized.includes('request blocked by security policy');
}

function launchLoginBrowser({ browserInfo, profileDir, startUrl, debuggingPort }) {
  const browserProcess = spawn(
    browserInfo.executablePath,
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${path.resolve(profileDir)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      startUrl
    ],
    {
      detached: true,
      stdio: 'ignore'
    }
  );

  browserProcess.unref();
}

function isKickOriginUrl(value) {
  try {
    return new URL(value).origin === 'https://kick.com';
  } catch {
    return false;
  }
}

function selectBridgePage(context) {
  const existingPages = context.pages().filter((candidate) => {
    if (typeof candidate.isClosed !== 'function') {
      return true;
    }

    return !candidate.isClosed();
  });

  const page =
    existingPages.find((candidate) => isKickHomePageUrl(candidate.url())) ||
    existingPages.find((candidate) => isKickOriginUrl(candidate.url())) ||
    existingPages[0] ||
    null;

  return {
    page,
    ownsPage: false
  };
}

async function resolveBridgePage(context) {
  const selectedPage = selectBridgePage(context);
  if (selectedPage.page) {
    return selectedPage;
  }

  const deadline = Date.now() + BRIDGE_PAGE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const nextSelection = selectBridgePage(context);
    if (nextSelection.page) {
      return nextSelection;
    }

    const remaining = Math.max(1, deadline - Date.now());
    try {
      const nextPage = await context.waitForEvent('page', { timeout: Math.min(remaining, 1_000) });
      if (nextPage && (typeof nextPage.isClosed !== 'function' || !nextPage.isClosed())) {
        return {
          page: nextPage,
          ownsPage: false
        };
      }
    } catch {
      // Keep polling until timeout before creating a dedicated page.
    }
  }

  const page = await context.newPage();

  return {
    page,
    ownsPage: true
  };
}

async function ensureActiveBridgePage(context, page) {
  if (page && (typeof page.isClosed !== 'function' || !page.isClosed())) {
    return page;
  }

  const resolved = await resolveBridgePage(context);
  return resolved.page;
}

function isClosedTargetError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.toLowerCase().includes('target page, context or browser has been closed');
}

async function openExistingBrowserBridge({ debuggingPort }) {
  const normalizedPort = Number(debuggingPort);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    throw new Error('No saved debugging port is available for the login browser.');
  }

  const endpoint = `http://${REMOTE_DEBUGGING_HOST}:${normalizedPort}`;
  await waitForExistingDevTools(endpoint);

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 960 }
  }));
  const { page, ownsPage } = await resolveBridgePage(context);

  return {
    browser,
    context,
    page,
    browserInfo: {
      label: 'Existing Kick login browser',
      executablePath: 'already-running'
    },
    browserProcess: null,
    ownsBrowserProcess: false,
    ownsPage,
    debuggingPort: normalizedPort
  };
}

async function openConnectedBrowserBridge({ debuggingPort, statusFile, storedSession, profileDir, preferredBrowserPath }) {
  if (!debuggingPort) {
    await safeUpdateStatus(statusFile, 'ERROR', BROWSER_RECONNECT_REQUIRED_MESSAGE, storedSession);
    throw new Error(BROWSER_RECONNECT_REQUIRED_MESSAGE);
  }

  try {
    return await openExistingBrowserBridge({ debuggingPort });
  } catch {
    await safeUpdateStatus(statusFile, 'ERROR', BROWSER_RECONNECT_REQUIRED_MESSAGE, storedSession);
    throw new Error(BROWSER_RECONNECT_REQUIRED_MESSAGE);
  }
}

function resolveChromiumBrowser(preferredBrowserPath) {
  if (preferredBrowserPath && existsSync(preferredBrowserPath)) {
    return {
      label: path.basename(preferredBrowserPath, path.extname(preferredBrowserPath)),
      executablePath: preferredBrowserPath
    };
  }

  for (const candidate of SYSTEM_BROWSER_CANDIDATES) {
    if (existsSync(candidate.executablePath)) {
      return candidate;
    }
  }

  throw new Error('No supported local Chrome or Edge installation was found. Install Chrome or Edge, or set KICK_BROWSER_PATH.');
}

async function openBrowserBridge({ preferredBrowserPath, profileDir, startUrl, startMinimized, detachProcess = false }) {
  const browserInfo = resolveChromiumBrowser(preferredBrowserPath);
  const resolvedProfileDir = path.resolve(profileDir);
  const debuggingPort = await getAvailablePort();
  const browserProcess = spawn(
    browserInfo.executablePath,
    [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${resolvedProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      startMinimized ? '--start-minimized' : '--new-window',
      startUrl
    ],
    {
      detached: detachProcess,
      stdio: 'ignore'
    }
  );

  if (detachProcess) {
    browserProcess.unref();
  }

  await waitForDevTools(debuggingPort, browserProcess, browserInfo.label);

  const browser = await chromium.connectOverCDP(`http://${REMOTE_DEBUGGING_HOST}:${debuggingPort}`);
  const context = browser.contexts()[0] ?? (await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1440, height: 960 }
  }));
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    browser,
    context,
    page,
    browserInfo,
    browserProcess,
    ownsBrowserProcess: true,
    ownsPage: true,
    debuggingPort
  };
}

async function closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess, ownsPage = true) {
  if (!ownsBrowserProcess) {
    if (ownsPage) {
      await settleBrowserOperation(() => page?.close(), 1_000);
    }

    return;
  }

  if (ownsPage) {
    await settleBrowserOperation(() => page?.close(), 1_000);
  }

  await settleBrowserOperation(() => browser?.close(), 1_500);

  if (ownsBrowserProcess && browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    browserProcess.kill();
    await settleBrowserOperation(() => waitForProcessExit(browserProcess), 1_500);
  }
}

async function disconnectBrowserBridge(browser) {
  // Let the short-lived login bridge process exit instead of explicitly closing the shared Chrome session.
  return browser;
}

function settleBrowserOperation(operation, timeoutMs) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, timeoutMs);

    Promise.resolve()
      .then(() => operation?.())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeoutId);
        resolve();
      });
  });
}

async function waitForDevTools(debuggingPort, browserProcess, browserLabel) {
  const endpoint = `http://${REMOTE_DEBUGGING_HOST}:${debuggingPort}/json/version`;
  const deadline = Date.now() + REMOTE_DEBUGGING_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the browser opens its debugging endpoint.
    }

    await delay(REMOTE_DEBUGGING_POLL_INTERVAL_MS);
  }

  if (browserProcess.exitCode !== null) {
    throw new Error(`${browserLabel} closed before its debugging endpoint became available.`);
  }

  throw new Error(`${browserLabel} did not open its debugging endpoint in time.`);
}

function waitForProcessExit(browserProcess) {
  return new Promise((resolve) => {
    if (browserProcess.exitCode !== null) {
      resolve();
      return;
    }

    browserProcess.once('exit', resolve);
  });
}

async function waitForExistingDevTools(endpoint) {
  const deadline = Date.now() + EXISTING_BROWSER_CONNECT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling briefly in case the login browser is still starting.
    }

    await delay(REMOTE_DEBUGGING_POLL_INTERVAL_MS);
  }

  throw new Error('Saved login browser debugging endpoint is unavailable.');
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on('error', reject);
    server.listen(0, REMOTE_DEBUGGING_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve a local debugging port.'));
        return;
      }

      server.close(() => {
        resolve(address.port);
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function requireArg(cliArgs, key) {
  const value = cliArgs[key];
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

async function readJson(filePath, fallback) {
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function safeUpdateStatus(filePath, state, message, session) {
  if (!filePath) {
    return;
  }

  const validSession = hasValidKickSession(session) ? session : null;

  await writeJson(filePath, {
    state,
    message,
    hasToken: Boolean(validSession?.token),
    isAuthenticated: Boolean(validSession?.token),
    tokenExpiresAt: validSession?.expiresAt || null,
    profile: validSession?.profile || null,
    updatedAt: now()
  });
}

function now() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`Usage:
  node bridge/kick-bridge.mjs login --status-file <file> --cookie-file <file> --session-file <file> --profile-dir <dir> --meta-file <file>
  node bridge/kick-bridge.mjs serve --status-file <file> --cookie-file <file> --session-file <file> --profile-dir <dir> --meta-file <file>
  node bridge/kick-bridge.mjs fetch-live-following --status-file <file> --cookie-file <file> --session-file <file> --profile-dir <dir> --meta-file <file> --output-file <file>
  node bridge/kick-bridge.mjs fetch-channel-chat --status-file <file> --cookie-file <file> --session-file <file> --profile-dir <dir> --meta-file <file> --output-file <file> --channel-slug <slug>`);
}
