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
const BACKGROUND_FETCH_WARMUP_MS = 1_500;
const MAX_FOLLOWED_CURSOR_PAGES = 25;

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
      startMinimized: false
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
    await page.goto(KICK_HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    }).catch(() => undefined);

    const session = await waitForAuthenticatedSession({
      context,
      page,
      cookieFile,
      sessionFile
    });

    await safeUpdateStatus(
      statusFile,
      'READY',
      `Connected as ${session.profile.username}.`,
      session
    );
  } finally {
    await closeBrowserBridge(page, browser, browserProcess, false);
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

  let session;
  try {
    session = await openExistingBrowserBridge({
      debuggingPort: metadata.debuggingPort
    });
  } catch (error) {
    try {
      session = await openBrowserBridge({
        preferredBrowserPath: metadata.browserPath || process.env.KICK_BROWSER_PATH,
        profileDir,
        startUrl: 'about:blank',
        startMinimized: true
      });
    } catch (launchError) {
      await safeUpdateStatus(
        statusFile,
        'ERROR',
        'Could not open the background Kick browser profile. Sign in again if the saved session was lost.',
        storedSession
      );
      throw launchError;
    }
  }

  const { browser, context, page, browserInfo, browserProcess, ownsBrowserProcess } = session;

  try {
    if (Array.isArray(storedCookies) && storedCookies.length > 0) {
      await context.addCookies(storedCookies);
    }

    const channels = await fetchFollowedChannelsFromBrowser(page, storedSession.token);

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
    await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess);
  }
}

async function fetchChannelChat(cliArgs) {
  const statusFile = requireArg(cliArgs, 'status-file');
  const cookieFile = requireArg(cliArgs, 'cookie-file');
  const sessionFile = requireArg(cliArgs, 'session-file');
  const metaFile = requireArg(cliArgs, 'meta-file');
  const outputFile = requireArg(cliArgs, 'output-file');
  const profileDir = requireArg(cliArgs, 'profile-dir');
  const channelSlug = requireArg(cliArgs, 'channel-slug').trim().toLowerCase();

  if (!channelSlug) {
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

  let session;
  try {
    session = await openExistingBrowserBridge({
      debuggingPort: metadata.debuggingPort
    });
  } catch {
    session = await openBrowserBridge({
      preferredBrowserPath: metadata.browserPath || process.env.KICK_BROWSER_PATH,
      profileDir,
      startUrl: 'about:blank',
      startMinimized: true
    });
  }

  const { browser, context, page, browserProcess, ownsBrowserProcess } = session;

  try {
    if (Array.isArray(storedCookies) && storedCookies.length > 0) {
      await context.addCookies(storedCookies);
    }

    const chat = await fetchChannelChatFromBrowser(page, channelSlug);
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
    await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess);
  }
}

async function serveBridge(cliArgs) {
  const statusFile = requireArg(cliArgs, 'status-file');
  const cookieFile = requireArg(cliArgs, 'cookie-file');
  const sessionFile = requireArg(cliArgs, 'session-file');
  const metaFile = requireArg(cliArgs, 'meta-file');
  const profileDir = requireArg(cliArgs, 'profile-dir');

  const metadata = await readJson(metaFile, {});
  const storedCookies = await readJson(cookieFile, []);
  const storedSession = await readKickSession(sessionFile);

  if (!hasValidKickSession(storedSession)) {
    await invalidateSavedSession(sessionFile, cookieFile);
    await safeUpdateStatus(statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
    throw new Error('Kick session is missing or expired. Sign in again.');
  }

  let session;
  try {
    session = await openExistingBrowserBridge({
      debuggingPort: metadata.debuggingPort
    });
  } catch {
    session = await openBrowserBridge({
      preferredBrowserPath: metadata.browserPath || process.env.KICK_BROWSER_PATH,
      profileDir,
      startUrl: 'about:blank',
      startMinimized: true
    });
  }

  const { browser, context, page, browserProcess, ownsBrowserProcess } = session;

  try {
    if (Array.isArray(storedCookies) && storedCookies.length > 0) {
      await context.addCookies(storedCookies);
    }

    await ensureKickHomePage(page);
    writeProtocolLine({ type: 'ready' });

    const state = {
      statusFile,
      cookieFile,
      sessionFile,
      context,
      page
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
  } finally {
    await closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess);
  }
}

async function handleServiceRequest(line, state) {
  let requestId = null;

  try {
    const request = JSON.parse(line);
    requestId = request?.id ? String(request.id) : null;

    if (request?.command === 'fetch-live-following') {
      state.page = await ensureServicePage(state);
      const storedSession = await readKickSession(state.sessionFile);
      if (!hasValidKickSession(storedSession)) {
        await invalidateSavedSession(state.sessionFile, state.cookieFile);
        await safeUpdateStatus(state.statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
        throw new Error('Kick session is missing or expired. Sign in again.');
      }

      const channels = await fetchFollowedChannelsFromBrowser(state.page, storedSession.token);
      await persistServiceCookies(state.context, state.cookieFile);
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
      return;
    }

    if (request?.command === 'fetch-channel-chat') {
      state.page = await ensureServicePage(state);
      const channelSlug = typeof request.channelSlug === 'string' ? request.channelSlug.trim().toLowerCase() : '';
      if (!channelSlug) {
        throw new Error('Kick channel slug is required.');
      }

      const storedSession = await readKickSession(state.sessionFile);
      if (!hasValidKickSession(storedSession)) {
        await invalidateSavedSession(state.sessionFile, state.cookieFile);
        await safeUpdateStatus(state.statusFile, 'IDLE', 'Kick session is missing or expired. Sign in again.', null);
        throw new Error('Kick session is missing or expired. Sign in again.');
      }

      const chat = await fetchChannelChatFromBrowser(state.page, channelSlug);
      await persistServiceCookies(state.context, state.cookieFile);
      await safeUpdateStatus(
        state.statusFile,
        'READY',
        chat.messages.length === 0
          ? `Connected as ${storedSession.profile.username}, but Kick returned no recent chat messages for ${channelSlug}.`
          : `Loaded ${chat.messages.length} recent chat messages for ${channelSlug}.`,
        storedSession
      );

      writeProtocolLine({
        id: requestId,
        ok: true,
        result: chat
      });
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

function writeProtocolLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function ensureServicePage(state) {
  if (state.page && !state.page.isClosed()) {
    return state.page;
  }

  state.page = await state.context.newPage();
  return state.page;
}

async function waitForAuthenticatedSession({ context, page, cookieFile, sessionFile }) {
  const deadline = Date.now() + LOGIN_CAPTURE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const session = await captureKickSession(context, page);
    if (session) {
      await writeJson(sessionFile, session);
      const refreshedCookies = await context.cookies(KICK_HOME_URL).catch(() => []);
      if (Array.isArray(refreshedCookies) && refreshedCookies.length > 0) {
        await writeJson(cookieFile, refreshedCookies);
      }
      return session;
    }

    await page.waitForTimeout(LOGIN_CAPTURE_POLL_INTERVAL_MS);
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
  const profile = await extractAuthenticatedProfile(page, token);
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

async function extractAuthenticatedProfile(page, authToken) {
  return page.evaluate(async ({ token, kickApiBaseUrl }) => {
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

    const profileResponse = await fetch(`${kickApiBaseUrl}/api/v2/channels/${encodeURIComponent(username)}`, {
      headers: {
        authorization: token,
        'x-app-platform': 'web',
        accept: 'application/json'
      }
    }).catch(() => null);

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
    token: authToken,
    kickApiBaseUrl: KICK_API_BASE_URL
  });
}

function parseFollowedChannelsPayload(payloadText) {
  const payload = JSON.parse(payloadText);
  return {
    nextCursor: payload.nextCursor ?? null,
    channels: Array.isArray(payload.channels) ? payload.channels : []
  };
}

async function fetchFollowedChannelsFromBrowser(page, authToken) {
  await ensureKickHomePage(page);

  const result = await page.evaluate(async ({ endpoint, token, maxPages }) => {
    const collectedChannels = [];
    const seenCursors = new Set();
    let nextCursor = null;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const query = nextCursor === null ? '' : `?cursor=${encodeURIComponent(String(nextCursor))}`;
      const response = await fetch(`${endpoint}${query}`, {
        headers: {
          authorization: token,
          'x-app-platform': 'web',
          accept: 'application/json'
        }
      }).catch(() => null);

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
    token: authToken,
    maxPages: MAX_FOLLOWED_CURSOR_PAGES
  });

  if (!result?.ok) {
    if (result?.status === 401 || result?.status === 403) {
      throw new Error('Kick rejected the saved session. Sign in again.');
    }

    throw new Error(result?.bodySnippet || 'Kick browser request failed while loading followings.');
  }

  return dedupeChannels(normalizeFollowedChannels(result.channels));
}

async function fetchChannelChatFromBrowser(page, channelSlug) {
  await ensureKickHomePage(page);

  const result = await page.evaluate(async ({ normalizedChannelSlug, kickApiBaseUrl, kickWebUrl }) => {
    const jsonHeaders = {
      accept: 'application/json'
    };

    const normalizeBadges = (value) => {
      if (!Array.isArray(value)) {
        return [];
      }

      return value
        .map((badge) => ({
          type: typeof badge?.type === 'string' ? badge.type : '',
          text: typeof badge?.text === 'string' ? badge.text : typeof badge?.type === 'string' ? badge.type : '',
          count: Number.isFinite(Number(badge?.count)) ? Number(badge.count) : null
        }))
        .filter((badge) => badge.type || badge.text);
    };

    const normalizeMessage = (message) => {
      if (!message || typeof message !== 'object') {
        return null;
      }

      return {
        id: String(message.id || ''),
        content: typeof message.content === 'string' ? message.content : '',
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

    const channelResponse = await fetch(`${kickApiBaseUrl}/api/v2/channels/${encodeURIComponent(normalizedChannelSlug)}`, {
      credentials: 'include',
      headers: jsonHeaders
    }).catch(() => null);

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

    let channelPayload;
    try {
      channelPayload = JSON.parse(channelPayloadText);
    } catch {
      return {
        ok: false,
        status: channelResponse.status,
        bodySnippet: channelPayloadText.slice(0, 500)
      };
    }

    const channelId =
      channelPayload?.id ||
      channelPayload?.chatroom?.channel_id ||
      channelPayload?.chatroom?.id ||
      null;

    if (!channelId) {
      return {
        ok: false,
        status: 500,
        bodySnippet: `Kick did not return a chat id for ${normalizedChannelSlug}.`
      };
    }

    const historyResponse = await fetch(`${kickWebUrl}/api/v1/chat/${encodeURIComponent(String(channelId))}/history`, {
      credentials: 'include',
      headers: jsonHeaders
    }).catch(() => null);

    if (!historyResponse) {
      return {
        ok: false,
        status: 0,
        bodySnippet: 'Background Kick chat history request failed.'
      };
    }

    const historyPayloadText = await historyResponse.text();
    if (!historyResponse.ok) {
      return {
        ok: false,
        status: historyResponse.status,
        bodySnippet: historyPayloadText.slice(0, 500)
      };
    }

    let historyPayload;
    try {
      historyPayload = JSON.parse(historyPayloadText);
    } catch {
      return {
        ok: false,
        status: historyResponse.status,
        bodySnippet: historyPayloadText.slice(0, 500)
      };
    }

    const historyData = historyPayload?.data && typeof historyPayload.data === 'object'
      ? historyPayload.data
      : historyPayload;
    const messages = Array.isArray(historyData?.messages)
      ? historyData.messages.map(normalizeMessage).filter(Boolean)
      : [];
    const pinnedMessage = normalizeMessage(historyData?.pinned_message?.message || historyPayload?.pinned_message?.message || null);
    const resolvedChatroomId =
      historyData?.chatroom_id ||
      historyPayload?.chatroom_id ||
      channelPayload?.chatroom?.id ||
      channelPayload?.livestream?.chatroom_id ||
      null;
    const resolvedChannelSlug = typeof channelPayload?.slug === 'string' ? channelPayload.slug : normalizedChannelSlug;

    return {
      ok: true,
      chat: {
        channelSlug: resolvedChannelSlug,
        channelId: Number(channelId),
        chatroomId: resolvedChatroomId !== null ? Number(resolvedChatroomId) : null,
        displayName: typeof channelPayload?.user?.username === 'string' ? channelPayload.user.username : resolvedChannelSlug,
        channelUrl: `https://kick.com/${resolvedChannelSlug}`,
        avatarUrl: channelPayload?.user?.profile_pic || channelPayload?.user?.profile_picture || channelPayload?.profile_picture || null,
        cursor: typeof historyData?.cursor === 'string' ? historyData.cursor : null,
        messages,
        pinnedMessage,
        updatedAt: new Date().toISOString()
      }
    };
  }, {
    normalizedChannelSlug: channelSlug,
    kickApiBaseUrl: KICK_API_BASE_URL,
    kickWebUrl: KICK_WEB_URL
  });

  if (!result?.ok) {
    if (result?.status === 401 || result?.status === 403) {
      throw new Error('Kick rejected the saved session. Sign in again.');
    }

    if (result?.status === 404) {
      throw new Error(`Kick could not find chat for channel ${channelSlug}.`);
    }

    throw new Error(result?.bodySnippet || `Kick browser request failed while loading chat for ${channelSlug}.`);
  }

  return result.chat;
}

async function ensureKickHomePage(page) {
  const currentUrl = typeof page.url === 'function' ? page.url() : '';
  if (currentUrl.startsWith(KICK_HOME_URL)) {
    return;
  }

  await page.goto(KICK_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  }).catch(() => undefined);
  await page.waitForTimeout(BACKGROUND_FETCH_WARMUP_MS);
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

function normalizeFollowedChannels(channels) {
  return channels.map((channel) => ({
    channelSlug: channel.channel_slug || channel.user_username || channel.slug || '',
    displayName: channel.user_username || channel.channel_slug || channel.slug || 'unknown',
    isLive: channel.is_live === true,
    thumbnailUrl: channel.profile_picture || null,
    channelUrl: `https://kick.com/${channel.channel_slug || channel.user_username || channel.slug || ''}`,
    chatUrl: `https://kick.com/${channel.channel_slug || channel.user_username || channel.slug || ''}`
  })).filter((channel) => channel.channelSlug && channel.isLive);
}

function dedupeChannels(channels) {
  const deduped = new Map();

  for (const channel of channels) {
    const existing = deduped.get(channel.channelSlug);
    if (!existing || (!existing.isLive && channel.isLive)) {
      deduped.set(channel.channelSlug, channel);
    }
  }

  return Array.from(deduped.values());
}

async function extractChannels(page) {
  return page.evaluate((reservedValues) => {
    const reservedPaths = new Set(reservedValues);
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
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
        chatUrl: `https://kick.com/${slug}`
      });
    };

    const walk = (value) => {
      if (!value) {
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
        return;
      }

      if (typeof value !== 'object') {
        return;
      }

      const objectValue = value;
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
        addCandidate({
          channelSlug: slug,
          displayName:
            objectValue.display_name ||
            objectValue.displayName ||
            objectValue.name ||
            objectValue.user?.username ||
            slug,
          thumbnailUrl:
            objectValue.thumbnail?.url ||
            objectValue.user?.profile_pic ||
            objectValue.user?.profilePicture ||
            null,
          isLive: true,
          score: 100
        });
      }

      for (const nestedValue of Object.values(objectValue)) {
        walk(nestedValue);
      }
    };

    for (const script of Array.from(document.querySelectorAll('script'))) {
      const content = script.textContent?.trim();
      if (!content || content.length < 2 || content.length > 2_000_000) {
        continue;
      }

      if (!(content.startsWith('{') || content.startsWith('['))) {
        continue;
      }

      try {
        walk(JSON.parse(content));
      } catch {
        // Ignore non-JSON script blocks.
      }
    }

    if (candidates.size > 0) {
      return Array.from(candidates.values())
        .sort((left, right) => right.score - left.score)
        .map(({ score, ...candidate }) => candidate);
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
      if (!isLive) {
        continue;
      }

      addCandidate({
        channelSlug: slug,
        displayName: normalize(anchor.getAttribute('aria-label') || anchor.textContent || slug),
        isLive: true,
        thumbnailUrl: anchor.querySelector('img')?.getAttribute('src') || null,
        score: 50 + (anchor.querySelector('img') ? 15 : 0) + Math.min(blob.length, 25)
      });
    }

    return Array.from(candidates.values())
      .sort((left, right) => right.score - left.score)
      .map(({ score, ...candidate }) => candidate);
  }, Array.from(RESERVED_PATHS));
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

  return {
    browser,
    context,
    page: await context.newPage(),
    browserInfo: {
      label: 'Existing Kick login browser',
      executablePath: 'already-running'
    },
    browserProcess: null,
    ownsBrowserProcess: false,
    debuggingPort: normalizedPort
  };
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

async function openBrowserBridge({ preferredBrowserPath, profileDir, startUrl, startMinimized }) {
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
      stdio: 'ignore'
    }
  );

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
    debuggingPort
  };
}

async function closeBrowserBridge(page, browser, browserProcess, ownsBrowserProcess) {
  await page?.close().catch(() => undefined);

  await browser.close().catch(() => undefined);

  if (!ownsBrowserProcess) {
    return;
  }

  if (ownsBrowserProcess && browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    browserProcess.kill();
    await waitForProcessExit(browserProcess);
  }
}

async function waitForDevTools(debuggingPort, browserProcess, browserLabel) {
  const endpoint = `http://${REMOTE_DEBUGGING_HOST}:${debuggingPort}/json/version`;
  const deadline = Date.now() + REMOTE_DEBUGGING_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (browserProcess.exitCode !== null) {
      throw new Error(`${browserLabel} closed before its debugging endpoint became available.`);
    }

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
