import { Fragment, startTransition, useEffect, useEffectEvent, useMemo, useState } from 'react';
import {
  fetchTwitchChannelChat,
  fetchTwitchChannelChatEmotes,
  fetchTwitchLiveFollowedChannels,
  fetchTwitchTrackedChannels,
  getTwitchAuthStatus,
  getTwitchOAuthLoginUrl,
  sendTwitchChannelChatMessage,
} from './api';
import type { ChannelChat, ChannelChatBadge, ChannelChatEmote, ChannelChatMessage, ChatProvider, FollowedChannel, KickBridgeStatus } from './types';

const FALLBACK_TWITCH_STATUS: KickBridgeStatus = {
  state: 'IDLE',
  message: 'Twitch OAuth has not been started yet.',
  hasToken: false,
  isAuthenticated: false,
  tokenExpiresAt: null,
  profile: null,
  oauthEnabled: false,
  hasBrowserSession: false,
  authMode: 'NONE',
  grantedScopes: [],
  updatedAt: new Date(0).toISOString()
};

const BRIDGE_STATE_LABELS: Record<KickBridgeStatus['state'], string> = {
  IDLE: 'Idle',
  RUNNING: 'Running',
  READY: 'Ready',
  ERROR: 'Error'
};

const TRACKED_CHANNELS_STORAGE_KEY = 'chatterbro:twitch:tracked-channel-slugs';

interface TwitchPanelProps {
  onSelectProvider: (provider: ChatProvider) => void;
}

function parseTrackedChannelSlugs(value: string) {
  return [...new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  )];
}

function serializeTrackedChannelSlugs(channelSlugs: string[]) {
  return channelSlugs.join(', ');
}

function mergeDiscoveredChannels(followedChannels: FollowedChannel[], trackedChannels: FollowedChannel[]) {
  const mergedChannels = new Map<string, FollowedChannel>();

  for (const channel of [...followedChannels, ...trackedChannels]) {
    const normalizedSlug = channel.channelSlug.trim().toLowerCase();
    if (!normalizedSlug) {
      continue;
    }

    const currentChannel = mergedChannels.get(normalizedSlug);
    if (!currentChannel) {
      mergedChannels.set(normalizedSlug, channel);
      continue;
    }

    mergedChannels.set(normalizedSlug, {
      provider: channel.provider,
      channelSlug: channel.channelSlug || currentChannel.channelSlug,
      displayName: channel.displayName || currentChannel.displayName,
      isLive: currentChannel.isLive || channel.isLive,
      channelUrl: channel.channelUrl || currentChannel.channelUrl,
      chatUrl: channel.chatUrl || currentChannel.chatUrl,
      thumbnailUrl: channel.thumbnailUrl ?? currentChannel.thumbnailUrl,
      broadcasterUserId: channel.broadcasterUserId ?? currentChannel.broadcasterUserId,
      channelId: channel.channelId ?? currentChannel.channelId,
      chatroomId: channel.chatroomId ?? currentChannel.chatroomId,
      viewerCount: channel.viewerCount ?? currentChannel.viewerCount,
      streamTitle: channel.streamTitle ?? currentChannel.streamTitle,
      categoryName: channel.categoryName ?? currentChannel.categoryName,
      tags: channel.tags.length > 0 ? channel.tags : currentChannel.tags,
      subscriberBadgeImageUrlsByMonths: channel.subscriberBadgeImageUrlsByMonths ?? currentChannel.subscriberBadgeImageUrlsByMonths ?? null,
    });
  }

  return [...mergedChannels.values()].sort((left, right) => {
    if (left.isLive !== right.isLive) {
      return left.isLive ? -1 : 1;
    }

    const viewerDelta = (right.viewerCount ?? -1) - (left.viewerCount ?? -1);
    if (viewerDelta !== 0) {
      return viewerDelta;
    }

    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
  });
}

function appendLocalChatMessage(currentChat: ChannelChat | null, nextMessage: ChannelChatMessage) {
  if (!currentChat) {
    return currentChat;
  }

  if (currentChat.messages.some((message) => message.id === nextMessage.id)) {
    return currentChat;
  }

  const nextMessages = currentChat.messages.length >= 200
    ? [...currentChat.messages.slice(-199), nextMessage]
    : [...currentChat.messages, nextMessage];

  return {
    ...currentChat,
    messages: nextMessages,
    updatedAt: new Date().toISOString()
  };
}

function formatClockTime(value: string | null | undefined) {
  if (!value) {
    return 'just now';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'just now';
  }

  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AvatarMedia({ imageUrl, label }: { imageUrl: string | null | undefined; label: string }) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  if (!imageUrl || imageFailed) {
    return <span>{label.slice(0, 1).toUpperCase()}</span>;
  }

  return <img src={imageUrl} alt={label} onError={() => setImageFailed(true)} />;
}

function renderBadge(badge: ChannelChatBadge) {
  const title = badge.count ? `${badge.text} ${badge.count}` : badge.text;

  if (badge.imageUrl) {
    return <img className="chat-badge-icon chat-badge-image" key={`${badge.type}-${badge.count ?? 'none'}-${badge.imageUrl}`} src={badge.imageUrl} alt={title} title={title} />;
  }

  return <span className="chat-badge-icon" key={`${badge.type}-${badge.count ?? 'none'}`} title={title}>{badge.text.slice(0, 1).toUpperCase()}</span>;
}

function renderMessageBody(content: string, emoteIndex: Record<string, ChannelChatEmote>) {
  return content.split(/(\s+)/).map((token, index) => {
    if (token.trim().length === 0) {
      return <Fragment key={`space-${index}`}>{token}</Fragment>;
    }

    const matchedEmote = emoteIndex[token];
    if (!matchedEmote) {
      return <Fragment key={`text-${index}`}>{token}</Fragment>;
    }

    return (
      <img
        key={`emote-${matchedEmote.code}-${index}`}
        className="chat-inline-emote"
        src={matchedEmote.imageUrl}
        alt={matchedEmote.code}
        title={`${matchedEmote.code} · ${matchedEmote.provider}`}
      />
    );
  });
}

export function TwitchPanel({ onSelectProvider }: TwitchPanelProps) {
  const [status, setStatus] = useState<KickBridgeStatus>(FALLBACK_TWITCH_STATUS);
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [trackedChannelSlugs, setTrackedChannelSlugs] = useState<string[]>([]);
  const [trackedChannelDraft, setTrackedChannelDraft] = useState('');
  const [selectedChannelSlug, setSelectedChannelSlug] = useState<string | null>(null);
  const [channelChat, setChannelChat] = useState<ChannelChat | null>(null);
  const [channelEmotes, setChannelEmotes] = useState<ChannelChatEmote[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [activity, setActivity] = useState('Twitch mode is idle. Connect Twitch once and Chatterbro will load your live followings and chat buffer through the local backend.');
  const [error, setError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [isSendingChat, setIsSendingChat] = useState(false);

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.channelSlug === selectedChannelSlug) ?? null,
    [channels, selectedChannelSlug],
  );
  const profile = status.profile;
  const isAuthenticated = status.isAuthenticated;
  const hasChatReadScope = status.grantedScopes.includes('chat:read');
  const hasChatWriteScope = status.grantedScopes.includes('chat:edit');
  const sessionExpiryLabel = status.tokenExpiresAt
    ? new Date(status.tokenExpiresAt).toLocaleString()
    : 'No token stored';
  const emoteIndex = useMemo(
    () => Object.fromEntries(channelEmotes.map((emote) => [emote.code, emote])),
    [channelEmotes],
  );
  const displayedChatMessages = useMemo(
    () => channelChat ? [...channelChat.messages].reverse() : [],
    [channelChat],
  );

  const refreshStatus = useEffectEvent(async () => {
    try {
      const nextStatus = await getTwitchAuthStatus();
      startTransition(() => {
        setStatus(nextStatus);
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to reach the Twitch auth status endpoint.');
    }
  });

  const refreshSelectedChat = useEffectEvent(async () => {
    if (!selectedChannel || !hasChatReadScope) {
      return;
    }

    try {
      const nextChat = await fetchTwitchChannelChat({
        channelSlug: selectedChannel.channelSlug,
        channelUserId: selectedChannel.broadcasterUserId,
        displayName: selectedChannel.displayName,
        avatarUrl: selectedChannel.thumbnailUrl,
        fast: true,
      });

      startTransition(() => {
        setChannelChat(nextChat);
      });
    } catch {
      // Keep the last successful buffer snapshot visible during polling failures.
    }
  });

  useEffect(() => {
    void refreshStatus();

    const params = new URLSearchParams(window.location.search);
    const authProvider = params.get('provider');
    const authResult = params.get('auth');
    const authMessage = params.get('message');
    const storedTrackedChannels = window.localStorage.getItem(TRACKED_CHANNELS_STORAGE_KEY);
    if (storedTrackedChannels) {
      setTrackedChannelSlugs(parseTrackedChannelSlugs(storedTrackedChannels));
    }

    if (authProvider === 'twitch' && authResult === 'success') {
      setActivity(authMessage || 'Twitch OAuth connected successfully. Refresh channels to load your live followings.');
      params.delete('provider');
      params.delete('auth');
      params.delete('message');
      const nextQuery = params.toString();
      window.history.replaceState({}, document.title, `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`);
      void refreshStatus();
    } else if (authProvider === 'twitch' && authResult === 'error') {
      setError(authMessage || 'Twitch OAuth sign-in failed.');
      params.delete('provider');
      params.delete('auth');
      params.delete('message');
      const nextQuery = params.toString();
      window.history.replaceState({}, document.title, `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`);
    }

    const intervalId = window.setInterval(() => {
      void refreshStatus();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (trackedChannelSlugs.length === 0) {
      window.localStorage.removeItem(TRACKED_CHANNELS_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(TRACKED_CHANNELS_STORAGE_KEY, serializeTrackedChannelSlugs(trackedChannelSlugs));
  }, [trackedChannelSlugs]);

  useEffect(() => {
    if (!selectedChannel || !isAuthenticated || !hasChatReadScope) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshSelectedChat();
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedChannel?.channelSlug, isAuthenticated, hasChatReadScope]);

  async function loadChannels() {
    if (!isAuthenticated) {
      setError('Connect Twitch first so the app can use your saved OAuth session.');
      return;
    }

    setIsLoadingChannels(true);
    setError(null);

    try {
      const [followedChannels, trackedChannels] = await Promise.all([
        fetchTwitchLiveFollowedChannels(),
        trackedChannelSlugs.length > 0 ? fetchTwitchTrackedChannels(trackedChannelSlugs) : Promise.resolve<FollowedChannel[]>([]),
      ]);
      const nextChannels = mergeDiscoveredChannels(followedChannels, trackedChannels);

      startTransition(() => {
        setChannels(nextChannels);
        if (selectedChannelSlug && !nextChannels.some((channel) => channel.channelSlug === selectedChannelSlug)) {
          setSelectedChannelSlug(null);
          setChannelChat(null);
          setChannelEmotes([]);
        }
        setActivity(
          nextChannels.length === 0
            ? 'No live followed or tracked Twitch channels are online right now.'
            : `Loaded ${nextChannels.filter((channel) => channel.isLive).length} live Twitch channel${nextChannels.filter((channel) => channel.isLive).length === 1 ? '' : 's'}.`
        );
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to load Twitch channels.');
    } finally {
      setIsLoadingChannels(false);
    }
  }

  async function openChat(channel: FollowedChannel) {
    setSelectedChannelSlug(channel.channelSlug);
    setIsLoadingChat(true);
    setChatError(null);
    setSendError(null);

    try {
      const [nextChat, nextCatalog] = await Promise.all([
        fetchTwitchChannelChat({
          channelSlug: channel.channelSlug,
          channelUserId: channel.broadcasterUserId,
          displayName: channel.displayName,
          avatarUrl: channel.thumbnailUrl,
        }),
        fetchTwitchChannelChatEmotes(channel.channelSlug, channel.broadcasterUserId),
      ]);

      startTransition(() => {
        setChannelChat(nextChat);
        setChannelEmotes(nextCatalog.emotes);
        setActivity(
          nextChat.messages.length === 0
            ? `Opened Twitch chat for ${channel.displayName}. The live IRC buffer is connected, but no recent messages are cached yet.`
            : `Opened Twitch chat for ${channel.displayName} with ${nextChat.messages.length} buffered message${nextChat.messages.length === 1 ? '' : 's'}.`
        );
      });
    } catch (caughtError) {
      setChatError(caughtError instanceof Error ? caughtError.message : 'Failed to load Twitch chat.');
    } finally {
      setIsLoadingChat(false);
    }
  }

  function handleAddTrackedChannels() {
    const nextTrackedChannels = parseTrackedChannelSlugs(trackedChannelDraft);
    if (nextTrackedChannels.length === 0) {
      return;
    }

    startTransition(() => {
      setTrackedChannelSlugs((currentTrackedChannels) => [...new Set([...currentTrackedChannels, ...nextTrackedChannels])]);
      setTrackedChannelDraft('');
      setActivity(
        nextTrackedChannels.length === 1
          ? `Added ${nextTrackedChannels[0]} to the Twitch watchlist.`
          : `Added ${nextTrackedChannels.length} Twitch channel slugs to the local watchlist.`
      );
    });
  }

  function handleRemoveTrackedChannel(channelSlug: string) {
    startTransition(() => {
      setTrackedChannelSlugs((currentTrackedChannels) => currentTrackedChannels.filter((entry) => entry !== channelSlug));
      setChannels((currentChannels) => currentChannels.filter((channel) => channel.channelSlug !== channelSlug || channel.isLive));
      if (selectedChannelSlug === channelSlug) {
        setSelectedChannelSlug(null);
        setChannelChat(null);
        setChannelEmotes([]);
      }
      setActivity(`Removed ${channelSlug} from the Twitch watchlist.`);
    });
  }

  async function handleSendChatMessage() {
    if (!selectedChannel || !channelChat) {
      return;
    }

    if (!hasChatWriteScope) {
      setSendError('Reconnect Twitch with the chat:edit scope before sending messages from Chatterbro.');
      return;
    }

    const content = chatDraft.trim();
    if (content.length === 0) {
      setSendError('Enter a chat message before sending it.');
      return;
    }

    setIsSendingChat(true);
    setSendError(null);

    try {
      const response = await sendTwitchChannelChatMessage(selectedChannel.channelSlug, {
        content,
        broadcasterUserId: channelChat.channelUserId,
      });
      const optimisticMessage: ChannelChatMessage = {
        id: response.messageId,
        content,
        type: 'message',
        createdAt: new Date().toISOString(),
        threadParentId: null,
        sender: {
          id: profile?.userId ?? null,
          username: profile?.username || 'you',
          slug: (profile?.username || 'you').toLowerCase(),
          color: null,
          badges: []
        }
      };

      startTransition(() => {
        setChannelChat((currentChat) => appendLocalChatMessage(currentChat, optimisticMessage));
        setChatDraft('');
        setActivity(`Sent a Twitch chat message to ${selectedChannel.displayName}.`);
      });

      window.setTimeout(() => {
        void refreshSelectedChat();
      }, 900);
    } catch (caughtError) {
      setSendError(caughtError instanceof Error ? caughtError.message : 'Failed to send the Twitch chat message.');
    } finally {
      setIsSendingChat(false);
    }
  }

  return (
    <main className="page-shell">
      <div className="provider-switcher">
        <button className="secondary-button" type="button" onClick={() => onSelectProvider('kick')}>
          Kick
        </button>
        <button className="primary-button" type="button" disabled>
          Twitch
        </button>
      </div>

      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Chatterbro</p>
          <h1>React dashboard for Twitch followings and live chat.</h1>
          <p className="hero-description">
            The UI stays in React. Kotlin runs the local API. Twitch OAuth powers followed-channel discovery through Helix, while the backend keeps a live IRC chat buffer so the current channel chat can refresh without touching the Kick browser flow.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="metric-card accent-card">
            <span className="metric-label">Twitch auth</span>
            <strong>{BRIDGE_STATE_LABELS[status.state]}</strong>
            <small>{status.oauthEnabled ? 'OAuth configured' : 'OAuth not configured'}</small>
          </div>
          <div className="metric-card">
            <span className="metric-label">Active profile</span>
            <strong>{profile?.username || 'Not signed in'}</strong>
            <small>{profile ? 'Twitch account is connected' : 'Sign in required'}</small>
          </div>
          <div className="metric-card">
            <span className="metric-label">Granted scopes</span>
            <strong>{status.grantedScopes.length}</strong>
            <small>{status.grantedScopes.length > 0 ? status.grantedScopes.join(', ') : status.message}</small>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel control-panel">
          <div className="panel-header">
            <h2>Session control</h2>
            <span className={`status-pill status-${status.state.toLowerCase()}`}>{BRIDGE_STATE_LABELS[status.state]}</span>
          </div>

          {profile ? (
            <div className="profile-summary">
              <div className="profile-avatar">
                <AvatarMedia imageUrl={profile.avatarUrl} label={profile.username} />
              </div>
              <div className="profile-copy">
                <strong>{profile.username}</strong>
                <span>Connected Twitch profile</span>
              </div>
              <a className="secondary-button" href={profile.channelUrl} target="_blank" rel="noopener noreferrer">
                Open channel
              </a>
            </div>
          ) : (
            <div className="message-strip subtle-strip compact-strip">
              <strong>Twitch profile</strong>
              <p>No Twitch profile is connected yet.</p>
            </div>
          )}

          <div className="tracked-channel-manager">
            <label className="field-label">
              Add tracked channels
              <div className="tracked-channel-input-row">
                <input
                  className="text-input"
                  type="text"
                  value={trackedChannelDraft}
                  onChange={(event) => setTrackedChannelDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') {
                      return;
                    }

                    event.preventDefault();
                    handleAddTrackedChannels();
                  }}
                  placeholder="pokimane, lirik, your-channel"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <button className="secondary-button" type="button" onClick={handleAddTrackedChannels} disabled={trackedChannelDraft.trim().length === 0}>
                  Add
                </button>
              </div>
            </label>

            {trackedChannelSlugs.length > 0 ? (
              <div className="tracked-chip-list">
                {trackedChannelSlugs.map((channelSlug) => (
                  <button className="tracked-chip" key={channelSlug} type="button" onClick={() => handleRemoveTrackedChannel(channelSlug)} title={`Remove ${channelSlug}`}>
                    <span>{channelSlug}</span>
                    <span aria-hidden>×</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="message-strip subtle-strip compact-strip">
                <strong>Local watchlist</strong>
                <p>Save a few Twitch logins here and Chatterbro will merge them into the same list as your live followed channels.</p>
              </div>
            )}
          </div>

          <div className="action-row">
            {!isAuthenticated ? (
              <button className="primary-button" type="button" onClick={() => window.location.assign(getTwitchOAuthLoginUrl())}>
                Connect Twitch via OAuth
              </button>
            ) : null}
            <button className="secondary-button" type="button" onClick={() => void loadChannels()} disabled={isLoadingChannels || !isAuthenticated}>
              {isLoadingChannels ? 'Refreshing channels...' : 'Refresh channels'}
            </button>
          </div>

          <div className="message-strip">
            <strong>Activity</strong>
            <p>{activity}</p>
          </div>

          <div className="message-strip subtle-strip">
            <strong>Session status</strong>
            <p>{status.message}</p>
          </div>

          <div className="message-strip subtle-strip compact-strip">
            <strong>Session expiry</strong>
            <p>{sessionExpiryLabel}</p>
          </div>

          {!hasChatReadScope && isAuthenticated ? (
            <div className="message-strip subtle-strip">
              <strong>Chat read scope</strong>
              <p>Reconnect Twitch with the chat:read scope to keep the live IRC buffer populated for open channels.</p>
            </div>
          ) : null}

          {!hasChatWriteScope && isAuthenticated ? (
            <div className="message-strip subtle-strip">
              <strong>Chat send scope</strong>
              <p>Reconnect Twitch with the chat:edit scope before sending messages from Chatterbro.</p>
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
            <span className="mono-label">oauth + irc</span>
          </div>

          <ol className="step-list">
            <li>Click <strong>Connect Twitch via OAuth</strong>.</li>
            <li>Approve the Helix and chat scopes in your browser.</li>
            <li>Refresh channels to merge live followings with any tracked Twitch logins saved locally.</li>
            <li>Open chat on a channel and the backend will keep refreshing its Twitch IRC buffer.</li>
          </ol>

          <p className="helper-copy">
            Twitch followings, channel metadata, badges, and native emotes all come from the official Helix API. Recent chat is buffered locally from Twitch chat after you open a channel.
          </p>
        </article>
      </section>

      <section className="panel channel-panel">
        <div className="panel-header">
          <div>
            <h2>Followings + Watchlist</h2>
            <p className="subtle-copy">
              {channels.length === 0
                ? 'No Twitch channels are loaded yet.'
                : `${channels.filter((channel) => channel.isLive).length} live Twitch channel${channels.filter((channel) => channel.isLive).length === 1 ? '' : 's'} are currently visible.`}
            </p>
          </div>
          <span className="mono-label">Twitch channels</span>
        </div>

        {channels.length === 0 ? (
          <div className="empty-state">
            <p>No live followed or tracked Twitch channels are loaded yet.</p>
            <span>Connect Twitch first, then refresh channels to load your live followings and any extra tracked logins.</span>
          </div>
        ) : (
          <div className="channel-grid">
            {channels.map((channel) => (
              <article className="channel-card" key={channel.channelSlug}>
                <div className="channel-card-topline">
                  <div className="channel-identity">
                    <div className="channel-avatar">
                      <AvatarMedia imageUrl={channel.thumbnailUrl} label={channel.displayName} />
                    </div>
                    <div>
                      <h3>{channel.displayName}</h3>
                      <p>{channel.channelSlug}</p>
                    </div>
                  </div>
                  <span className={`channel-status-pill ${channel.isLive ? 'channel-status-live' : 'channel-status-offline'}`}>
                    {channel.isLive ? 'Live' : 'Offline'}
                  </span>
                </div>

                <div className="channel-meta-list">
                  <span>{channel.categoryName || 'No category yet'}</span>
                  <span>{channel.viewerCount === null ? 'Viewer count unavailable' : `${channel.viewerCount} viewer${channel.viewerCount === 1 ? '' : 's'}`}</span>
                </div>

                <p className="channel-title">{channel.streamTitle || 'No stream title available right now.'}</p>

                {channel.tags.length > 0 ? (
                  <div className="channel-tag-list">
                    {channel.tags.slice(0, 4).map((tag) => <span className="channel-tag" key={`${channel.channelSlug}-${tag}`}>{tag}</span>)}
                  </div>
                ) : null}

                <div className="channel-actions">
                  <button className="secondary-button" type="button" onClick={() => window.open(channel.channelUrl, '_blank', 'noopener,noreferrer')}>
                    Open channel
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      void openChat(channel);
                    }}
                    disabled={!hasChatReadScope || (isLoadingChat && selectedChannelSlug === channel.channelSlug)}
                  >
                    {isLoadingChat && selectedChannelSlug === channel.channelSlug ? 'Loading chat...' : selectedChannelSlug === channel.channelSlug ? 'Refresh chat' : 'Open chat'}
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
                ? `Twitch IRC buffer for ${selectedChannel.displayName}. The backend keeps joining the channel after you open it, and this panel polls that local buffer.`
                : 'Open any followed or tracked Twitch channel to start loading its local chat buffer.'}
            </p>
          </div>
          {selectedChannel ? <span className="mono-label">{selectedChannel.channelSlug}</span> : null}
        </div>

        {selectedChannel ? (
          <div className="chat-shell">
            <div className="chat-summary-card">
              <div className="chat-summary-topline">
                <span className="chat-kick-mark">Twitch live chat</span>
                <span className="chat-transport-pill">IRC buffer</span>
              </div>

              <div className="chat-summary-main">
                <div className="channel-identity">
                  <div className="channel-avatar">
                    <AvatarMedia imageUrl={channelChat?.avatarUrl || selectedChannel.thumbnailUrl} label={selectedChannel.displayName} />
                  </div>
                  <div className="chat-summary-copy">
                    <h3>{channelChat?.displayName || selectedChannel.displayName}</h3>
                    <p>{selectedChannel.channelSlug}</p>
                  </div>
                </div>

                <div className="chat-summary-stats">
                  <span>{channelChat?.messages.length ?? 0} messages</span>
                  <span>Updated {formatClockTime(channelChat?.updatedAt)}</span>
                  <span>{hasChatReadScope ? 'chat:read active' : 'chat:read missing'}</span>
                </div>
              </div>

              <div className="channel-actions compact-actions chat-toolbar">
                <button className="secondary-button" type="button" onClick={() => window.open(selectedChannel.channelUrl, '_blank', 'noopener,noreferrer')}>
                  Open Twitch
                </button>
                <button className="primary-button" type="button" onClick={() => {
                  void openChat(selectedChannel);
                }} disabled={isLoadingChat || !hasChatReadScope}>
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

            {sendError ? (
              <div className="message-strip error-strip">
                <strong>Send error</strong>
                <p>{sendError}</p>
              </div>
            ) : null}

            {!channelChat && isLoadingChat ? (
              <div className="empty-state">
                <p>Loading Twitch chat buffer...</p>
                <span>The backend is joining this Twitch channel and collecting the first available live messages.</span>
              </div>
            ) : null}

            {channelChat ? (
              channelChat.messages.length === 0 ? (
                <div className="empty-state">
                  <p>No buffered Twitch messages are available yet.</p>
                  <span>Leave the chat open for a moment and Chatterbro will keep polling the local IRC buffer.</span>
                </div>
              ) : (
                <div className="chat-feed">
                  {displayedChatMessages.map((message) => (
                    <article className="chat-message" key={message.id}>
                      <span className="chat-message-time">{formatClockTime(message.createdAt)}</span>
                      <div className="chat-message-main">
                        <div className="chat-message-header">
                          <div className="chat-sender-group">
                            {message.sender.badges.length > 0 ? <span className="chat-badge-list">{message.sender.badges.map(renderBadge)}</span> : null}
                            <strong className="chat-sender-name" style={message.sender.color ? { color: message.sender.color } : undefined}>{message.sender.username}</strong>
                          </div>
                          <span className="chat-message-separator">:</span>
                          <span className="chat-message-inline-body">{renderMessageBody(message.content, emoteIndex)}</span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )
            ) : null}

            <div className="chat-composer-shell">
              <div className="chat-composer-status">
                <span className="chat-composer-status-dot" />
                <span>{hasChatWriteScope ? 'Official Twitch send is ready' : 'Reconnect for chat:edit before sending'}</span>
              </div>

              <div className="chat-composer-form">
                <textarea
                  className="chat-composer-textarea"
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.shiftKey) {
                      return;
                    }

                    event.preventDefault();
                    void handleSendChatMessage();
                  }}
                  placeholder={hasChatWriteScope
                    ? `Write to ${selectedChannel.displayName}...`
                    : 'Reconnect Twitch with chat:edit before sending from Chatterbro.'}
                  disabled={!hasChatWriteScope || isSendingChat}
                  maxLength={500}
                />

                <div className="chat-composer-button-row">
                  <div className="chat-composer-hints">
                    <span className="chat-composer-help">Enter to send, Shift+Enter for newline</span>
                    <span className="chat-composer-help">{chatDraft.trim().length}/500</span>
                  </div>

                  {!hasChatWriteScope ? (
                    <button className="primary-button" type="button" onClick={() => window.location.assign(getTwitchOAuthLoginUrl())}>
                      Grant chat:edit
                    </button>
                  ) : (
                    <button className="primary-button" type="button" onClick={() => void handleSendChatMessage()} disabled={isSendingChat || chatDraft.trim().length === 0}>
                      {isSendingChat ? 'Sending...' : 'Send message'}
                    </button>
                  )}

                  <a className="chat-composer-link" href={selectedChannel.channelUrl} target="_blank" rel="noopener noreferrer">
                    Open Twitch chat
                  </a>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <p>No Twitch chat selected yet.</p>
            <span>Refresh channels, then open chat on any followed or tracked Twitch channel to start buffering live messages locally.</span>
          </div>
        )}
      </section>
    </main>
  );
}