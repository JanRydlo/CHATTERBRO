import { startTransition, useEffect, useState } from 'react';
import { fetchChannelChat, fetchLiveFollowedChannels, getBridgeStatus, getOAuthLoginUrl, startBridge } from './api';
import type { ChannelChat, ChannelChatMessage, FollowedChannel, KickBridgeStatus } from './types';

const FALLBACK_STATUS: KickBridgeStatus = {
  state: 'IDLE',
  message: 'Kick bridge has not been started yet.',
  hasToken: false,
  isAuthenticated: false,
  tokenExpiresAt: null,
  profile: null,
  oauthEnabled: false,
  hasBrowserSession: false,
  authMode: 'NONE',
  updatedAt: new Date(0).toISOString()
};

const BRIDGE_STATE_LABELS: Record<KickBridgeStatus['state'], string> = {
  IDLE: 'Idle',
  RUNNING: 'Running',
  READY: 'Ready',
  ERROR: 'Error'
};

export default function App() {
  const [bridgeStatus, setBridgeStatus] = useState<KickBridgeStatus>(FALLBACK_STATUS);
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<FollowedChannel | null>(null);
  const [channelChat, setChannelChat] = useState<ChannelChat | null>(null);
  const [isStartingBridge, setIsStartingBridge] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [activity, setActivity] = useState('Bridge session is idle. Connect Kick once and the app will keep using the saved session until it expires.');
  const [lastLoadedUsername, setLastLoadedUsername] = useState('');

  useEffect(() => {
    void refreshBridgeStatus();

    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('auth');
    const authMessage = params.get('message');
    if (authResult === 'success') {
      setActivity(authMessage || 'Kick OAuth connected successfully. Load followings when you are ready.');
      params.delete('auth');
      params.delete('message');
      const nextQuery = params.toString();
      window.history.replaceState({}, document.title, `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`);
      void refreshBridgeStatus();
    } else if (authResult === 'error') {
      setError(authMessage || 'Kick OAuth sign-in failed.');
      params.delete('auth');
      params.delete('message');
      const nextQuery = params.toString();
      window.history.replaceState({}, document.title, `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`);
    }

    const intervalId = window.setInterval(() => {
      void refreshBridgeStatus();
    }, 4000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const isAuthenticated = bridgeStatus.isAuthenticated && Boolean(bridgeStatus.profile);
  const profile = bridgeStatus.profile;
  const liveCountLabel = !lastLoadedUsername
    ? isAuthenticated && profile
      ? `No live followings loaded for ${profile.username} yet.`
      : 'Sign in to load your live followings.'
    : channels.length === 0
      ? `No live followings found for ${lastLoadedUsername}.`
      : `${channels.length} live followings found for ${lastLoadedUsername}.`;
  const sessionExpiryLabel = bridgeStatus.tokenExpiresAt
    ? new Date(bridgeStatus.tokenExpiresAt).toLocaleString()
    : 'No Kick token stored';
  const selectedChannelSlug = selectedChannel?.channelSlug || null;
  const needsBrowserSync = bridgeStatus.oauthEnabled && isAuthenticated && !bridgeStatus.hasBrowserSession;

  useEffect(() => {
    if (isAuthenticated) {
      return;
    }

    setSelectedChannel(null);
    setChannelChat(null);
    setChatError(null);
  }, [isAuthenticated]);

  async function refreshBridgeStatus() {
    try {
      const nextStatus = await getBridgeStatus();
      startTransition(() => {
        setBridgeStatus(nextStatus);
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to reach the backend bridge status endpoint.';
      setError(message);
    }
  }

  async function handleStartBridge() {
    if (bridgeStatus.oauthEnabled) {
      window.location.assign(getOAuthLoginUrl());
      return;
    }

    setIsStartingBridge(true);
    setError(null);

    try {
      const nextStatus = await startBridge();
      startTransition(() => {
        setBridgeStatus(nextStatus);
        setActivity('The Kick login browser was opened. Finish login there. As soon as Kick session data is captured, your profile will appear here.');
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to start the Kick login bridge.');
    } finally {
      setIsStartingBridge(false);
    }
  }

  async function ensureBrowserSessionForWebsiteData(featureLabel: string) {
    if (bridgeStatus.hasBrowserSession || !bridgeStatus.oauthEnabled) {
      return true;
    }

    setActivity(`Kick OAuth is connected, but ${featureLabel} still need a one-time Kick website session sync. Finish the browser sign-in window and retry.`);
    await startBrowserSessionSync();
    return false;
  }

  async function startBrowserSessionSync() {
    setIsStartingBridge(true);
    setError(null);

    try {
      const nextStatus = await startBridge();
      startTransition(() => {
        setBridgeStatus(nextStatus);
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to start the Kick website session sync.');
    } finally {
      setIsStartingBridge(false);
    }
  }

  async function handleLoadChannels() {
    if (!isAuthenticated || !profile) {
      setError('Connect Kick first so the app can use your saved session.');
      return;
    }

    if (!(await ensureBrowserSessionForWebsiteData('live followings'))) {
      return;
    }

    setIsLoadingChannels(true);
    setError(null);

    try {
      const loadedChannels = await fetchLiveFollowedChannels();
      startTransition(() => {
        setChannels(loadedChannels);
        setLastLoadedUsername(profile.username);
        setActivity(
          loadedChannels.length === 0
            ? `Connected as ${profile.username}, but no live followings were found.`
            : `Loaded ${loadedChannels.length} live followings for ${profile.username}.`
        );
      });
      await refreshBridgeStatus();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to load live followings.');
    } finally {
      setIsLoadingChannels(false);
    }
  }

  async function loadChannelChat(channel: FollowedChannel) {
    if (!isAuthenticated) {
      setChatError('Connect Kick first so the app can use your saved session.');
      return;
    }

    if (!(await ensureBrowserSessionForWebsiteData('chat history'))) {
      setSelectedChannel(channel);
      return;
    }

    setSelectedChannel(channel);
    setChatError(null);
    setIsLoadingChat(true);
    setChannelChat((currentChat) => currentChat?.channelSlug === channel.channelSlug ? currentChat : null);

    try {
      const nextChat = await fetchChannelChat(channel.channelSlug);
      startTransition(() => {
        setChannelChat(nextChat);
        setActivity(
          nextChat.messages.length === 0
            ? `Loaded chat for ${channel.displayName}, but Kick returned no recent messages.`
            : `Loaded ${nextChat.messages.length} recent chat messages for ${channel.displayName}.`
        );
      });
    } catch (caughtError) {
      setChatError(caughtError instanceof Error ? caughtError.message : 'Failed to load the selected channel chat.');
    } finally {
      setIsLoadingChat(false);
    }
  }

  function formatChatTimestamp(value: string | null) {
    if (!value) {
      return 'Unknown time';
    }

    return new Date(value).toLocaleString();
  }

  function renderChatMessage(message: ChannelChatMessage) {
    const senderBadges = message.sender.badges || [];

    return (
      <article className={`chat-message${message.threadParentId ? ' chat-message-reply' : ''}`} key={message.id}>
        <div className="chat-message-header">
          <div className="chat-sender-group">
            <strong className="chat-sender-name" style={message.sender.color ? { color: message.sender.color } : undefined}>
              {message.sender.username}
            </strong>
            {senderBadges.map((badge) => (
              <span className="chat-badge" key={`${message.id}-${badge.type}-${badge.text}`}>
                {badge.count ? `${badge.text} ${badge.count}` : badge.text}
              </span>
            ))}
            {message.type !== 'message' ? <span className="chat-type-pill">{message.type}</span> : null}
          </div>
          <span className="chat-message-time">{formatChatTimestamp(message.createdAt)}</span>
        </div>
        <p>{message.content || 'Empty message'}</p>
      </article>
    );
  }

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Chatterbro</p>
          <h1>React dashboard for a browser-backed Kick bridge.</h1>
          <p className="hero-description">
            The UI stays in React. Kotlin runs the local API. Kick OAuth handles account connection first, while the browser bridge is only kept for the unsupported followings and chat-read flows.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="metric-card accent-card">
            <span className="metric-label">Kick auth</span>
            <strong>{BRIDGE_STATE_LABELS[bridgeStatus.state]}</strong>
            <small>
              {bridgeStatus.authMode === 'OAUTH'
                ? 'OAuth connected'
                : bridgeStatus.authMode === 'BROWSER_SESSION'
                  ? 'Browser session connected'
                  : bridgeStatus.hasToken
                    ? 'Token captured'
                    : 'No token yet'}
            </small>
          </div>
          <div className="metric-card">
            <span className="metric-label">Active profile</span>
            <strong>{profile?.username || 'Not signed in'}</strong>
            <small>{profile ? 'Kick account is connected' : 'Sign in required'}</small>
          </div>
          <div className="metric-card">
            <span className="metric-label">Token expiry</span>
            <strong>{sessionExpiryLabel}</strong>
            <small>{bridgeStatus.message}</small>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel control-panel">
          <div className="panel-header">
            <h2>Session control</h2>
            <span className={`status-pill status-${bridgeStatus.state.toLowerCase()}`}>{BRIDGE_STATE_LABELS[bridgeStatus.state]}</span>
          </div>

          {profile ? (
            <div className="profile-summary">
              <div className="profile-avatar">
                {profile.avatarUrl ? <img src={profile.avatarUrl} alt={profile.username} /> : <span>{profile.username.slice(0, 1).toUpperCase()}</span>}
              </div>
              <div className="profile-copy">
                <strong>{profile.username}</strong>
                <span>Connected Kick profile</span>
              </div>
              <a className="kick-icon-badge" href={profile.channelUrl} target="_blank" rel="noopener noreferrer">
                Kick
              </a>
            </div>
          ) : (
            <div className="message-strip subtle-strip compact-strip">
              <strong>Kick profile</strong>
              <p>No Kick profile is connected yet.</p>
            </div>
          )}

          <div className="action-row">
            {!isAuthenticated ? (
              <button className="primary-button" onClick={handleStartBridge} disabled={isStartingBridge || bridgeStatus.state === 'RUNNING'}>
                {bridgeStatus.oauthEnabled
                  ? 'Connect Kick via OAuth'
                  : isStartingBridge
                    ? 'Opening Kick login...'
                    : bridgeStatus.state === 'RUNNING'
                      ? 'Waiting for Kick sign-in...'
                      : 'Connect Kick account'}
              </button>
            ) : needsBrowserSync ? (
              <button className="primary-button" onClick={startBrowserSessionSync} disabled={isStartingBridge || bridgeStatus.state === 'RUNNING'}>
                {isStartingBridge
                  ? 'Opening Kick browser sync...'
                  : bridgeStatus.state === 'RUNNING'
                    ? 'Waiting for website session sync...'
                    : 'Enable followings and chat sync'}
              </button>
            ) : null}
            <button className="secondary-button" onClick={handleLoadChannels} disabled={isLoadingChannels || !isAuthenticated}>
              {isLoadingChannels
                ? 'Loading live followings...'
                : needsBrowserSync
                  ? 'Prepare followings sync'
                  : 'Load live followings'}
            </button>
          </div>

          <div className="message-strip">
            <strong>Activity</strong>
            <p>{activity}</p>
          </div>

          <div className="message-strip subtle-strip">
            <strong>Bridge status</strong>
            <p>{bridgeStatus.message}</p>
          </div>

          {isAuthenticated ? (
            <div className="message-strip subtle-strip compact-strip">
              <strong>Session expiry</strong>
              <p>{sessionExpiryLabel}</p>
            </div>
          ) : null}

          {needsBrowserSync ? (
            <div className="message-strip subtle-strip">
              <strong>Website data sync</strong>
              <p>Kick OAuth is active, but live followings and recent chat still require one browser-based website session sync because those read endpoints are not yet exposed in the official Public API.</p>
            </div>
          ) : null}

          {error ? (
            <div className="message-strip error-strip">
              <strong>Backend error</strong>
              <p>{error}</p>
            </div>
          ) : null}
        </article>

        <article className="panel guide-panel">
          <div className="panel-header">
            <h2>Auth flow</h2>
            <span className="mono-label">oauth + website sync</span>
          </div>

          <ol className="step-list">
            <li>Click <strong>Connect Kick via OAuth</strong>.</li>
            <li>Finish the Kick authorization flow in your browser.</li>
            <li>If you need live followings or chat history, run the one-time website sync the first time you load them.</li>
          </ol>

          <p className="helper-copy">
            Kick's Public API now covers auth and profile reads cleanly, but followed-channel and chat-history reads still require the browser bridge until official read endpoints exist.
          </p>
        </article>
      </section>

      <section className="panel channel-panel">
        <div className="panel-header">
          <div>
            <h2>Live followings</h2>
            <p className="subtle-copy">{liveCountLabel}</p>
          </div>
          <span className="mono-label">Kick channels</span>
        </div>

        {channels.length === 0 ? (
          <div className="empty-state">
            <p>No live channels are loaded yet.</p>
            <span>Once your Kick session is connected, this panel will list every live followed channel returned by the backend.</span>
          </div>
        ) : (
          <div className="channel-grid">
            {channels.map((channel) => (
              <article className="channel-card" key={channel.channelSlug}>
                <div className="channel-identity">
                  <div className="channel-avatar">
                    {channel.thumbnailUrl ? <img src={channel.thumbnailUrl} alt={channel.displayName} /> : <span>{channel.displayName.slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div>
                    <h3>{channel.displayName}</h3>
                    <p>{channel.channelSlug}</p>
                  </div>
                </div>

                <div className="channel-actions">
                  <button className="secondary-button" onClick={() => window.open(channel.channelUrl, '_blank', 'noopener,noreferrer')}>
                    Open channel
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => {
                      void loadChannelChat(channel);
                    }}
                    disabled={isLoadingChat && selectedChannelSlug === channel.channelSlug}
                  >
                    {isLoadingChat && selectedChannelSlug === channel.channelSlug ? 'Loading chat...' : 'Open chat'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel chat-viewer-panel">
        <div className="panel-header">
          <div>
            <h2>Channel chat</h2>
            <p className="subtle-copy">
              {selectedChannel
                ? `Recent chat history for ${selectedChannel.displayName}.`
                : 'Click Open chat on any live followed channel to load its recent messages.'}
            </p>
          </div>
          {selectedChannel ? <span className="mono-label">{selectedChannel.channelSlug}</span> : null}
        </div>

        {selectedChannel ? (
          <>
            <div className="chat-summary-card">
              <div className="channel-identity">
                <div className="channel-avatar">
                  {channelChat?.avatarUrl || selectedChannel.thumbnailUrl ? (
                    <img src={channelChat?.avatarUrl || selectedChannel.thumbnailUrl || ''} alt={selectedChannel.displayName} />
                  ) : (
                    <span>{selectedChannel.displayName.slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div>
                  <h3>{channelChat?.displayName || selectedChannel.displayName}</h3>
                  <p>{channelChat?.messages.length ?? 0} recent messages loaded</p>
                </div>
              </div>

              <div className="channel-actions compact-actions">
                <button className="secondary-button" onClick={() => window.open(selectedChannel.channelUrl, '_blank', 'noopener,noreferrer')}>
                  Open channel
                </button>
                <button className="primary-button" onClick={() => {
                  void loadChannelChat(selectedChannel);
                }} disabled={isLoadingChat}>
                  {isLoadingChat ? 'Refreshing chat...' : 'Refresh chat'}
                </button>
              </div>
            </div>

            {chatError ? (
              <div className="message-strip error-strip">
                <strong>Chat error</strong>
                <p>{chatError}</p>
              </div>
            ) : null}

            {!channelChat && isLoadingChat ? (
              <div className="empty-state">
                <p>Loading recent chat messages...</p>
                <span>The app is fetching the selected channel's Kick chat through the browser bridge.</span>
              </div>
            ) : null}

            {channelChat?.pinnedMessage ? (
              <div className="pinned-chat-card">
                <span className="mono-label">Pinned</span>
                {renderChatMessage(channelChat.pinnedMessage)}
              </div>
            ) : null}

            {channelChat ? (
              channelChat.messages.length === 0 ? (
                <div className="empty-state">
                  <p>No recent chat messages were returned.</p>
                  <span>Kick may have an empty history for this channel right now.</span>
                </div>
              ) : (
                <div className="chat-feed">
                  {channelChat.messages.map((message) => renderChatMessage(message))}
                </div>
              )
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <p>No channel chat selected yet.</p>
            <span>After loading your live followings, click Open chat on any online channel to render its recent Kick chat here.</span>
          </div>
        )}
      </section>
    </main>
  );
}
