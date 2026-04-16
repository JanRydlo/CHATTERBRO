import Pusher, { type Options as PusherOptions } from 'pusher-js';
import { Fragment, type ReactNode, startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { fetchChannelChat, fetchChannelChatEmotes, fetchGlobalChatEmotes, fetchLiveFollowedChannels, getBridgeStatus, getOAuthLoginUrl, startBridge } from './api';
import type { ChannelChat, ChannelChatBadge, ChannelChatEmote, ChannelChatEmoteCatalog, ChannelChatMessage, FollowedChannel, KickBridgeStatus } from './types';

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

type LiveChatState = 'idle' | 'connecting' | 'live' | 'error';

const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
const KICK_PUSHER_OPTIONS: PusherOptions = {
  cluster: 'mt1',
  wsHost: 'ws-us2.pusher.com',
  wsPort: 80,
  wssPort: 443,
  forceTLS: true,
  enabledTransports: ['ws', 'wss'],
  disableStats: true
};

const INVISIBLE_EXTERNAL_EMOTE_PATTERN = /[\u200B-\u200D\uFEFF\u00AD\u{E0000}-\u{E007F}]/gu;
const KICK_PLACEHOLDER_PATTERN = /\[emote:(\d+):([^\]]+)\]/g;
const KICK_PLACEHOLDER_DETECTION_PATTERN = /\[emote:\d+:[^\]]+\]/;

interface RealtimeChatTarget {
  channelId: number | null;
  chatroomId: number | null;
}

interface ChannelEmoteCacheEntry {
  catalog: ChannelChatEmoteCatalog;
  index: Record<string, ChannelChatEmote>;
}

interface MatchedInlineEmoteToken {
  leadingText: string;
  trailingText: string;
  emote: ChannelChatEmote;
}

function getChannelEmoteCacheKey(channelSlug: string, channelUserId: number | null) {
  return `${channelSlug}:${channelUserId ?? 'none'}`;
}

function normalizeExternalEmoteCode(value: string) {
  return value.replace(INVISIBLE_EXTERNAL_EMOTE_PATTERN, '');
}

function parseSerializedBadge(value: string): ChannelChatBadge | null {
  const typeMatch = value.match(/type=([^;}]*)/i);
  const textMatch = value.match(/text=([^;}]*)/i);
  const countMatch = value.match(/count=([^;}]*)/i);
  const imageMatch = value.match(/(?:imageUrl|image_url|icon|icon_url|src|url)=([^;}]*)/i);
  const type = typeMatch?.[1]?.trim() || '';
  const text = textMatch?.[1]?.trim() || type;
  const count = Number(countMatch?.[1]);

  if (!type && !text) {
    return null;
  }

  return {
    type,
    text,
    count: Number.isFinite(count) ? count : null,
    imageUrl: imageMatch?.[1]?.trim() || null
  };
}

function resolveBadgeImageUrl(value: Record<string, unknown>) {
  const candidates = [
    value.image,
    value.image_url,
    value.icon,
    value.icon_url,
    value.src,
    value.url,
    value.badge_image,
    value.small_icon_url,
    value.thumbnail
  ];

  const match = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return match ?? null;
}

function resolvePreferredMessageContent(message: Record<string, unknown>) {
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : null;
  const candidates = [
    typeof message.content === 'string' ? message.content : '',
    typeof message.original_message === 'string' ? message.original_message : '',
    typeof message.body === 'string' ? message.body : '',
    typeof message.message === 'string' ? message.message : '',
    typeof message.text === 'string' ? message.text : '',
    typeof metadata?.original_message === 'string' ? metadata.original_message : '',
    typeof metadata?.body === 'string' ? metadata.body : '',
    typeof metadata?.text === 'string' ? metadata.text : ''
  ].filter((candidate) => candidate.length > 0);

  const kickPlaceholderCandidate = candidates.find((candidate) => KICK_PLACEHOLDER_DETECTION_PATTERN.test(candidate));
  if (kickPlaceholderCandidate) {
    return normalizeExternalEmoteCode(kickPlaceholderCandidate);
  }

  return normalizeExternalEmoteCode(candidates.sort((left, right) => right.length - left.length)[0] ?? '');
}

function getBadgeLabel(badge: ChannelChatBadge) {
  const badgeType = badge.type.toLowerCase();

  switch (badgeType) {
    case 'moderator':
      return 'MOD';
    case 'verified':
      return 'VER';
    case 'vip':
      return 'VIP';
    case 'founder':
      return 'F';
    case 'subscriber':
      return badge.count ? `S${badge.count}` : 'SUB';
    case 'sub_gifter':
      return badge.count ? `G${badge.count}` : 'G';
    case 'og':
      return 'OG';
    default:
      return (badge.text || badge.type || '?').slice(0, 3).toUpperCase();
  }
}

function getBadgeTitle(badge: ChannelChatBadge) {
  const label = badge.text || badge.type || 'Badge';
  return badge.count ? `${label} ${badge.count}` : label;
}

function renderSenderBadge(badge: ChannelChatBadge, key: string) {
  if (badge.imageUrl) {
    return <img className="chat-badge-icon chat-badge-image" key={key} src={badge.imageUrl} alt={getBadgeTitle(badge)} title={getBadgeTitle(badge)} loading="lazy" decoding="async" draggable={false} />;
  }

  return <span className="chat-badge-icon chat-badge-fallback" key={key} title={getBadgeTitle(badge)}>{getBadgeLabel(badge)}</span>;
}

function buildChannelEmoteIndex(catalog: ChannelChatEmoteCatalog) {
  const nextIndex: Record<string, ChannelChatEmote> = {};

  for (const emote of catalog.emotes) {
    const candidateKeys = new Set([emote.code, normalizeExternalEmoteCode(emote.code)]);

    for (const candidateKey of candidateKeys) {
      if (!candidateKey) {
        continue;
      }

      nextIndex[candidateKey] = emote;
    }
  }

  return nextIndex;
}

function matchInlineEmoteToken(token: string, emoteIndex: Record<string, ChannelChatEmote> | null): MatchedInlineEmoteToken | null {
  if (!emoteIndex) {
    return null;
  }

  const exactMatch = emoteIndex[token] ?? emoteIndex[normalizeExternalEmoteCode(token)];
  if (exactMatch) {
    return {
      leadingText: '',
      trailingText: '',
      emote: exactMatch
    };
  }

  const punctuationMatch = token.match(/^([([{"'“‘]*)(.+?)([)\]}!?,.;:"'”’]*)$/);
  if (!punctuationMatch) {
    return null;
  }

  const [, leadingText, candidateCode, trailingText] = punctuationMatch;
  if (!leadingText && !trailingText) {
    return null;
  }

  const emote = emoteIndex[candidateCode] ?? emoteIndex[normalizeExternalEmoteCode(candidateCode)];
  if (!emote) {
    return null;
  }

  return {
    leadingText,
    trailingText,
    emote
  };
}

function getKickPlaceholderEmoteUrl(emoteId: string) {
  return `https://files.kick.com/emotes/${emoteId}/fullsize`;
}

function renderTextSegmentWithExternalEmotes(
  text: string,
  messageId: string,
  segmentKey: string,
  emoteIndex: Record<string, ChannelChatEmote> | null
) {
  return text
    .split(/(\s+)/)
    .filter((part) => part.length > 0)
    .map((part, index) => {
      if (/^\s+$/.test(part)) {
        return <Fragment key={`${messageId}-${segmentKey}-space-${index}`}>{part}</Fragment>;
      }

      const matchedEmote = matchInlineEmoteToken(part, emoteIndex);
      if (!matchedEmote) {
        return <Fragment key={`${messageId}-${segmentKey}-text-${index}`}>{part}</Fragment>;
      }

      return (
        <Fragment key={`${messageId}-${segmentKey}-external-emote-${index}-${matchedEmote.emote.code}`}>
          {matchedEmote.leadingText}
          <img
            className="chat-inline-emote"
            src={matchedEmote.emote.imageUrl}
            alt={matchedEmote.emote.code}
            title={`${matchedEmote.emote.code} · ${matchedEmote.emote.provider}`}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
          {matchedEmote.trailingText}
        </Fragment>
      );
    });
}

function renderMessageContent(
  content: string,
  messageId: string,
  emoteIndex: Record<string, ChannelChatEmote> | null
) {
  const normalizedContent = normalizeExternalEmoteCode(content || 'Empty message');
  const renderedParts: ReactNode[] = [];

  let lastIndex = 0;
  let match = KICK_PLACEHOLDER_PATTERN.exec(normalizedContent);

  while (match) {
    const [rawMatch, emoteId, emoteCode] = match;

    if (match.index > lastIndex) {
      renderedParts.push(
        ...renderTextSegmentWithExternalEmotes(
          normalizedContent.slice(lastIndex, match.index),
          messageId,
          `segment-${lastIndex}`,
          emoteIndex
        )
      );
    }

    renderedParts.push(
      <img
        className="chat-inline-emote"
        key={`${messageId}-kick-emote-${emoteId}-${match.index}`}
        src={getKickPlaceholderEmoteUrl(emoteId)}
        alt={emoteCode}
        title={`${emoteCode} · Kick`}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    );

    lastIndex = match.index + rawMatch.length;
    match = KICK_PLACEHOLDER_PATTERN.exec(normalizedContent);
  }

  KICK_PLACEHOLDER_PATTERN.lastIndex = 0;

  if (lastIndex < normalizedContent.length) {
    renderedParts.push(
      ...renderTextSegmentWithExternalEmotes(
        normalizedContent.slice(lastIndex),
        messageId,
        `segment-${lastIndex}`,
        emoteIndex
      )
    );
  }

  if (renderedParts.length === 0) {
    return normalizedContent;
  }

  return renderedParts;
}

function parseRealtimeJson(value: unknown) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function unwrapRealtimeRecord(payload: unknown): Record<string, unknown> | null {
  let candidate = parseRealtimeJson(payload);

  for (let depth = 0; depth < 5; depth += 1) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return null;
    }

    const record = candidate as Record<string, unknown>;
    const nestedData = parseRealtimeJson(record.data);
    if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
      candidate = nestedData;
      continue;
    }

    if (record.message && typeof record.message === 'object' && !Array.isArray(record.message)) {
      candidate = record.message;
      continue;
    }

    if (record.chat_message && typeof record.chat_message === 'object' && !Array.isArray(record.chat_message)) {
      candidate = record.chat_message;
      continue;
    }

    return record;
  }

  return null;
}

function normalizeRealtimeBadge(value: unknown) {
  if (typeof value === 'string') {
    return parseSerializedBadge(value);
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const badge = value as Record<string, unknown>;
  const type = typeof badge.type === 'string' ? badge.type : '';
  const text = typeof badge.text === 'string' ? badge.text : type;
  const count = Number(badge.count);

  if (!type && !text) {
    return null;
  }

  return {
    type,
    text,
    count: Number.isFinite(count) ? count : null,
    imageUrl: resolveBadgeImageUrl(badge)
  };
}

function normalizeRealtimeChatMessage(payload: unknown): ChannelChatMessage | null {
  const message = unwrapRealtimeRecord(payload);

  if (!message) {
    return null;
  }

  const sender =
    message.sender && typeof message.sender === 'object'
      ? message.sender
      : message.user && typeof message.user === 'object'
        ? message.user
        : null;

  if (!sender || typeof sender !== 'object') {
    return null;
  }

  const senderRecord = sender as Record<string, unknown>;
  const identity = senderRecord.identity && typeof senderRecord.identity === 'object'
    ? senderRecord.identity
    : message.identity && typeof message.identity === 'object'
      ? message.identity
      : null;
  const identityRecord = identity && typeof identity === 'object' ? identity as Record<string, unknown> : null;
  const rawMessageId = message.id ?? message.message_id ?? message.uuid ?? null;
  const messageId = typeof rawMessageId === 'string'
    ? rawMessageId
    : Number.isFinite(Number(rawMessageId))
      ? String(rawMessageId)
      : '';
  const username = typeof senderRecord.username === 'string'
    ? senderRecord.username
    : typeof senderRecord.name === 'string'
      ? senderRecord.name
      : typeof senderRecord.slug === 'string'
        ? senderRecord.slug
        : '';
  const senderId = Number(senderRecord.id);
  const rawBadges = Array.isArray(identityRecord?.badges)
    ? identityRecord.badges
    : Array.isArray(senderRecord.badges)
      ? senderRecord.badges
      : [];
  const badges = rawBadges
      .map((badge) => normalizeRealtimeBadge(badge))
      .filter((badge): badge is NonNullable<ReturnType<typeof normalizeRealtimeBadge>> => badge !== null)

  if (!messageId || !username) {
    return null;
  }

  return {
    id: messageId,
    content: resolvePreferredMessageContent(message),
    type: typeof message.type === 'string' ? message.type : 'message',
    createdAt: typeof message.created_at === 'string'
      ? message.created_at
      : typeof message.createdAt === 'string'
        ? message.createdAt
        : typeof message.timestamp === 'string'
          ? message.timestamp
          : null,
    threadParentId: typeof message.thread_parent_id === 'string'
      ? message.thread_parent_id
      : Number.isFinite(Number(message.thread_parent_id))
        ? String(message.thread_parent_id)
        : typeof message.reply_to_message_id === 'string'
          ? message.reply_to_message_id
          : Number.isFinite(Number(message.reply_to_message_id))
            ? String(message.reply_to_message_id)
        : null,
    sender: {
      id: Number.isFinite(senderId) ? senderId : null,
      username,
      slug: typeof senderRecord.slug === 'string' ? senderRecord.slug : username.toLowerCase(),
      color: typeof identityRecord?.color === 'string'
        ? identityRecord.color
        : typeof senderRecord.color === 'string'
          ? senderRecord.color
          : null,
      badges
    }
  };
}

function getRealtimeChannelNames(target: RealtimeChatTarget): string[] {
  const channelNames = new Set<string>();

  if (target.chatroomId !== null) {
    channelNames.add(`chatroom_${target.chatroomId}`);
    channelNames.add(`chatrooms.${target.chatroomId}.v2`);
    channelNames.add(`chatrooms.${target.chatroomId}`);
  }

  if (target.channelId !== null) {
    channelNames.add(`channel_${target.channelId}`);
    channelNames.add(`channel.${target.channelId}`);
  }

  return [...channelNames];
}

function appendRealtimeChatMessage(currentChat: ChannelChat | null, target: RealtimeChatTarget, nextMessage: ChannelChatMessage) {
  if (!currentChat) {
    return currentChat;
  }

  if (target.chatroomId !== null && currentChat.chatroomId !== target.chatroomId) {
    return currentChat;
  }

  if (target.chatroomId === null && target.channelId !== null && currentChat.channelId !== target.channelId) {
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

function mergeChannelChat(currentChat: ChannelChat | null, nextChat: ChannelChat): ChannelChat {
  if (!currentChat || currentChat.channelSlug !== nextChat.channelSlug) {
    return nextChat;
  }

  const mergedMessages = [...nextChat.messages];
  const knownMessageIds = new Set(mergedMessages.map((message) => message.id));

  for (const message of currentChat.messages) {
    if (knownMessageIds.has(message.id)) {
      continue;
    }

    mergedMessages.push(message);
    knownMessageIds.add(message.id);
  }

  return {
    ...currentChat,
    ...nextChat,
    channelUserId: nextChat.channelUserId ?? currentChat.channelUserId,
    pinnedMessage: nextChat.pinnedMessage || currentChat.pinnedMessage,
    messages: mergedMessages.slice(-200)
  };
}

export default function App() {
  const [bridgeStatus, setBridgeStatus] = useState<KickBridgeStatus>(FALLBACK_STATUS);
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<FollowedChannel | null>(null);
  const [channelChat, setChannelChat] = useState<ChannelChat | null>(null);
  const [globalEmoteIndex, setGlobalEmoteIndex] = useState<Record<string, ChannelChatEmote>>({});
  const [channelEmoteCache, setChannelEmoteCache] = useState<Record<string, ChannelEmoteCacheEntry>>({});
  const [isStartingBridge, setIsStartingBridge] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [liveChatState, setLiveChatState] = useState<LiveChatState>('idle');
  const [liveChatError, setLiveChatError] = useState<string | null>(null);
  const [activity, setActivity] = useState('Bridge session is idle. Connect Kick once and the app will keep using the saved session until it expires.');
  const [lastLoadedUsername, setLastLoadedUsername] = useState('');
  const openChatRefreshInFlightRef = useRef(false);
  const emoteRequestsInFlightRef = useRef(new Set<string>());

  useEffect(() => {
    void refreshBridgeStatus();
    void preloadGlobalEmotes();

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

  async function preloadGlobalEmotes() {
    try {
      const catalog = await fetchGlobalChatEmotes();
      startTransition(() => {
        setGlobalEmoteIndex(buildChannelEmoteIndex(catalog));
      });
    } catch {
      // Keep global external emotes best-effort if the catalog is temporarily unavailable.
    }
  }

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
  const hasOpenChat = channelChat?.channelSlug === selectedChannelSlug;
  const needsBrowserSync = bridgeStatus.oauthEnabled && isAuthenticated && !bridgeStatus.hasBrowserSession;
  const activeEmoteCacheKey = channelChat
    ? getChannelEmoteCacheKey(channelChat.channelSlug, channelChat.channelUserId)
    : null;
  const activeChannelEmoteIndex = activeEmoteCacheKey
    ? channelEmoteCache[activeEmoteCacheKey]?.index ?? null
    : null;
  const activeEmoteIndex = {
    ...globalEmoteIndex,
    ...(activeChannelEmoteIndex ?? {})
  };
  const activeChatroomId = channelChat?.chatroomId ?? null;
  const activeChannelId = channelChat?.channelId ?? null;
  const liveChatStatusLabel = liveChatState === 'live'
    ? 'Live'
    : liveChatState === 'connecting'
      ? 'Connecting'
      : liveChatState === 'error'
        ? 'Disconnected'
        : 'Snapshot';
  const liveChatStatusClass = liveChatState === 'live'
    ? 'status-ready'
    : liveChatState === 'connecting'
      ? 'status-running'
      : liveChatState === 'error'
        ? 'status-error'
        : 'status-idle';

  useEffect(() => {
    if (isAuthenticated) {
      return;
    }

    setSelectedChannel(null);
    setChannelChat(null);
    setChatError(null);
    setLiveChatState('idle');
    setLiveChatError(null);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!channelChat || (activeChatroomId === null && activeChannelId === null)) {
      setLiveChatState('idle');
      setLiveChatError(null);
      return;
    }

    const realtimeTarget = {
      chatroomId: activeChatroomId,
      channelId: activeChannelId
    };
    const subscriptionNames = getRealtimeChannelNames(realtimeTarget);
    if (subscriptionNames.length === 0) {
      setLiveChatState('error');
      setLiveChatError('Kick did not expose a realtime subscription target for this channel.');
      return;
    }

    const pusher = new Pusher(KICK_PUSHER_KEY, KICK_PUSHER_OPTIONS);
    let hasMarkedLive = false;

    setLiveChatState('connecting');
    setLiveChatError(null);

    const markLive = (source: string) => {
      if (!hasMarkedLive) {
        hasMarkedLive = true;
        setActivity(`Live chat connected for ${channelChat.displayName} via ${source}. New Kick messages will appear automatically.`);
      }

      setLiveChatState('live');
    };

    const handleConnectionError = () => {
      setLiveChatState('error');
      setLiveChatError('Live chat disconnected. You can still refresh chat manually.');
    };

    const subscriptions = subscriptionNames.map((subscriptionName) => {
      const subscription = pusher.subscribe(subscriptionName);

      const handleSubscriptionSucceeded = () => {
        markLive(subscriptionName);
      };

      const handleGlobalEvent = (eventName: string, payload: unknown) => {
        if (eventName.startsWith('pusher:')) {
          return;
        }

        const nextMessage = normalizeRealtimeChatMessage(payload);
        if (!nextMessage) {
          return;
        }

        markLive(`${subscriptionName} · ${eventName}`);

        startTransition(() => {
          setChannelChat((currentChat) => appendRealtimeChatMessage(currentChat, realtimeTarget, nextMessage));
        });
      };

      subscription.bind('pusher:subscription_succeeded', handleSubscriptionSucceeded);
      subscription.bind_global(handleGlobalEvent);

      return {
        subscription,
        subscriptionName,
        handleSubscriptionSucceeded,
        handleGlobalEvent
      };
    });

    const handleChatMessage = (payload: unknown) => {
      const nextMessage = normalizeRealtimeChatMessage(payload);
      if (!nextMessage) {
        return;
      }

      markLive(`chatrooms.${activeChatroomId}.v2 · App\\Events\\ChatMessageEvent`);

      startTransition(() => {
        setChannelChat((currentChat) => appendRealtimeChatMessage(currentChat, realtimeTarget, nextMessage));
      });
    };

    for (const { subscription } of subscriptions) {
      subscription.bind('App\\Events\\ChatMessageEvent', handleChatMessage);
      subscription.bind('ChatMessageEvent', handleChatMessage);
    }

    pusher.connection.bind('error', handleConnectionError);

    return () => {
      for (const { subscription, subscriptionName, handleSubscriptionSucceeded, handleGlobalEvent } of subscriptions) {
        subscription.unbind('pusher:subscription_succeeded', handleSubscriptionSucceeded);
        subscription.unbind('App\\Events\\ChatMessageEvent', handleChatMessage);
        subscription.unbind('ChatMessageEvent', handleChatMessage);
        subscription.unbind_global(handleGlobalEvent);
        pusher.unsubscribe(subscriptionName);
      }

      pusher.connection.unbind('error', handleConnectionError);
      pusher.disconnect();
    };
  }, [activeChannelId, activeChatroomId, channelChat?.displayName]);

  useEffect(() => {
    if (!channelChat?.channelSlug) {
      return;
    }

    const cacheKey = getChannelEmoteCacheKey(channelChat.channelSlug, channelChat.channelUserId);
    if (channelEmoteCache[cacheKey] || emoteRequestsInFlightRef.current.has(cacheKey)) {
      return;
    }

    emoteRequestsInFlightRef.current.add(cacheKey);

    void (async () => {
      try {
        const nextCatalog = await fetchChannelChatEmotes(channelChat.channelSlug, channelChat.channelUserId);
        const nextEntry = {
          catalog: nextCatalog,
          index: buildChannelEmoteIndex(nextCatalog)
        };

        startTransition(() => {
          setChannelEmoteCache((currentCache) => currentCache[cacheKey]
            ? currentCache
            : {
                ...currentCache,
                [cacheKey]: nextEntry
              });
        });
      } catch {
        // Fall back to plain text if external emote catalogs are temporarily unavailable.
      } finally {
        emoteRequestsInFlightRef.current.delete(cacheKey);
      }
    })();
  }, [channelChat?.channelSlug, channelChat?.channelUserId, channelEmoteCache]);

  const refreshOpenChat = useEffectEvent(async () => {
    if (!isAuthenticated || !selectedChannelSlug || !hasOpenChat || isLoadingChat || openChatRefreshInFlightRef.current) {
      return;
    }

    openChatRefreshInFlightRef.current = true;

    try {
      const nextChat = await fetchChannelChat(selectedChannelSlug);

      startTransition(() => {
        setChannelChat((currentChat) => currentChat?.channelSlug === nextChat.channelSlug
          ? mergeChannelChat(currentChat, nextChat)
          : currentChat);
      });
    } catch {
      if (liveChatState !== 'live') {
        setLiveChatError('Live chat is delayed. Recent messages are still syncing automatically in the background.');
      }
    } finally {
      openChatRefreshInFlightRef.current = false;
    }
  });

  useEffect(() => {
    if (!isAuthenticated || !selectedChannelSlug || !hasOpenChat || isLoadingChat) {
      return;
    }

    let isDisposed = false;
    let timeoutId = 0;
    const refreshIntervalMs = liveChatState === 'live' ? 5000 : 2500;

    const scheduleNextRefresh = () => {
      timeoutId = window.setTimeout(async () => {
        await refreshOpenChat();

        if (!isDisposed) {
          scheduleNextRefresh();
        }
      }, refreshIntervalMs);
    };

    scheduleNextRefresh();

    return () => {
      isDisposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [hasOpenChat, isAuthenticated, isLoadingChat, liveChatState, selectedChannelSlug]);

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
    setLiveChatState('idle');
    setLiveChatError(null);
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

  function formatChatClockTime(value: string | null) {
    if (!value) {
      return '--:--';
    }

    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
      return '--:--';
    }

    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  function renderChatMessage(message: ChannelChatMessage) {
    const senderBadges = message.sender.badges || [];
    const timeLabel = formatChatClockTime(message.createdAt);
    const timeTitle = formatChatTimestamp(message.createdAt);
    const renderedMessageContent = renderMessageContent(message.content, message.id, activeEmoteIndex);

    return (
      <article className={`chat-message${message.threadParentId ? ' chat-message-reply' : ''}`} key={message.id}>
        <span className="chat-message-time" title={timeTitle}>{timeLabel}</span>
        <div className="chat-message-main">
          <div className="chat-message-header">
            <div className="chat-sender-group">
              {senderBadges.length > 0 ? <span className="chat-badge-list">{senderBadges.map((badge, index) => renderSenderBadge(badge, `${message.id}-${badge.type}-${index}`))}</span> : null}
              <strong className="chat-sender-name" style={message.sender.color ? { color: message.sender.color } : undefined}>
                {message.sender.username}
              </strong>
              {message.type !== 'message' ? <span className="chat-type-pill">{message.type}</span> : null}
            </div>
          </div>
          <p className="chat-message-body">{renderedMessageContent}</p>
        </div>
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
                ? `Read-only Kick-style chat mirror for ${selectedChannel.displayName}, with realtime updates layered over the latest snapshot.`
                : 'Click Open chat on any live followed channel to load its snapshot and render it in a Kick-style chat shell.'}
            </p>
          </div>
          {selectedChannel ? (
            <div className="chat-panel-meta">
              <span className="mono-label">{selectedChannel.channelSlug}</span>
              <span className={`status-pill ${liveChatStatusClass}`}>{liveChatStatusLabel}</span>
            </div>
          ) : null}
        </div>

        {selectedChannel ? (
          <div className="chat-shell">
            <div className="chat-summary-card">
              <div className="chat-summary-topline">
                <span className="chat-kick-mark">Kick chat mirror</span>
                <span className="chat-transport-pill">
                  {activeChatroomId !== null ? `chatroom_${activeChatroomId}` : 'snapshot mode'}
                </span>
              </div>

              <div className="chat-summary-main">
                <div>
                  <div className="channel-identity">
                    <div className="channel-avatar">
                      {channelChat?.avatarUrl || selectedChannel.thumbnailUrl ? (
                        <img src={channelChat?.avatarUrl || selectedChannel.thumbnailUrl || ''} alt={selectedChannel.displayName} />
                      ) : (
                        <span>{selectedChannel.displayName.slice(0, 1).toUpperCase()}</span>
                      )}
                    </div>
                    <div className="chat-summary-copy">
                      <h3>{channelChat?.displayName || selectedChannel.displayName}</h3>
                      <p>{selectedChannel.channelSlug}</p>
                    </div>
                  </div>
                </div>

                <div className="chat-summary-stats">
                  <span>{channelChat?.messages.length ?? 0} messages</span>
                  <span>Updated {formatChatClockTime(channelChat?.updatedAt ?? null)}</span>
                  <span>{liveChatState === 'live' ? 'Realtime on' : 'Snapshot sync'}</span>
                </div>
              </div>

              <div className="channel-actions compact-actions chat-toolbar">
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

            {liveChatError ? (
              <div className="message-strip error-strip">
                <strong>Realtime chat</strong>
                <p>{liveChatError}</p>
              </div>
            ) : null}

            {!channelChat && isLoadingChat ? (
              <div className="empty-state">
                <p>Loading recent chat messages...</p>
                <span>The app is fetching the initial snapshot through the browser bridge. Once it arrives, live Kick messages will append automatically.</span>
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
                  <span>Kick may have an empty history for this channel right now. If the live websocket is connected, new messages will still appear here automatically.</span>
                </div>
              ) : (
                <div className="chat-feed">
                  {channelChat.messages.map((message) => renderChatMessage(message))}
                </div>
              )
            ) : null}

            <div className="chat-composer-shell">
              <div className="chat-composer-status">
                <span className="chat-composer-status-dot" />
                <span>{liveChatState === 'live' ? 'Live mirror' : 'Read-only sync'}</span>
              </div>
              <div className="chat-composer-input">
                Message sending stays on Kick. Open the channel to join the chat directly.
              </div>
              <a className="chat-composer-link" href={selectedChannel.channelUrl} target="_blank" rel="noopener noreferrer">
                Open Kick chat
              </a>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <p>No channel chat selected yet.</p>
            <span>After loading your live followings, click Open chat on any online channel to render its recent Kick chat here and keep it updating in real time.</span>
          </div>
        )}
      </section>
    </main>
  );
}
