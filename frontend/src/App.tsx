import Pusher, { type Options as PusherOptions } from 'pusher-js';
import { Fragment, type ReactNode, startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { fetchChannelChat, fetchChannelChatEmotes, fetchGlobalChatEmotes, fetchLiveFollowedChannels, fetchTrackedChannels, getBridgeStatus, getOAuthLoginUrl, sendChannelChatMessage, startBridge } from './api';
import type { ChannelChat, ChannelChatBadge, ChannelChatEmote, ChannelChatEmoteCatalog, ChannelChatMessage, ChannelChatSender, FollowedChannel, KickBridgeStatus } from './types';

const FALLBACK_STATUS: KickBridgeStatus = {
  state: 'IDLE',
  message: 'Kick OAuth has not been started yet.',
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
const SECURITY_POLICY_BLOCKED_PATTERN = /security policy|request blocked by security policy/i;
const BROWSER_RECONNECT_REQUIRED_PATTERN = /reconnect kick browser|browser sync is not running|sign in again|rejected the saved session|security policy/i;
const TOKEN_ONLY_ACTIVITY_MESSAGE = 'Kick OAuth is connected. Token-only mode is active. No Kick browser will be kept running in the background.';
const TOKEN_ONLY_FOLLOWINGS_MESSAGE = 'Live followings are not available through Kick Public API in OAuth-only mode.';
const TOKEN_ONLY_CHAT_MESSAGE = 'Chat history is not available through Kick Public API in OAuth-only mode.';
const TRACKED_CHANNELS_STORAGE_KEY = 'chatterbro:tracked-channel-slugs';

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

function isBrowserReconnectRequiredMessage(value: string | null | undefined) {
  return Boolean(value && BROWSER_RECONNECT_REQUIRED_PATTERN.test(value));
}

function isSecurityPolicyBlockedMessage(value: string | null | undefined) {
  return Boolean(value && SECURITY_POLICY_BLOCKED_PATTERN.test(value));
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

function buildTokenOnlyChatShell(channel: FollowedChannel): ChannelChat {
  return {
    channelSlug: channel.channelSlug,
    channelId: channel.channelId,
    channelUserId: channel.broadcasterUserId,
    chatroomId: channel.chatroomId,
    displayName: channel.displayName,
    channelUrl: channel.channelUrl,
    avatarUrl: channel.thumbnailUrl,
    cursor: null,
    messages: [],
    pinnedMessage: null,
    updatedAt: new Date().toISOString()
  };
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

function sortTrackedChannels(channels: FollowedChannel[], trackedChannelSlugs: string[]) {
  const trackedOrder = new Map(trackedChannelSlugs.map((channelSlug, index) => [channelSlug, index]));

  return [...channels].sort((left, right) => {
    if (left.isLive !== right.isLive) {
      return left.isLive ? -1 : 1;
    }

    const viewerDelta = (right.viewerCount ?? -1) - (left.viewerCount ?? -1);
    if (viewerDelta !== 0) {
      return viewerDelta;
    }

    const trackedDelta = (trackedOrder.get(left.channelSlug) ?? Number.MAX_SAFE_INTEGER)
      - (trackedOrder.get(right.channelSlug) ?? Number.MAX_SAFE_INTEGER);
    if (trackedDelta !== 0) {
      return trackedDelta;
    }

    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' });
  });
}

function mergeDiscoveredChannel(currentChannel: FollowedChannel | undefined, nextChannel: FollowedChannel): FollowedChannel {
  if (!currentChannel) {
    return nextChannel;
  }

  return {
    channelSlug: nextChannel.channelSlug || currentChannel.channelSlug,
    displayName: nextChannel.displayName || currentChannel.displayName,
    isLive: currentChannel.isLive || nextChannel.isLive,
    channelUrl: nextChannel.channelUrl || currentChannel.channelUrl,
    chatUrl: nextChannel.chatUrl || currentChannel.chatUrl,
    thumbnailUrl: nextChannel.thumbnailUrl ?? currentChannel.thumbnailUrl,
    broadcasterUserId: nextChannel.broadcasterUserId ?? currentChannel.broadcasterUserId,
    channelId: nextChannel.channelId ?? currentChannel.channelId,
    chatroomId: nextChannel.chatroomId ?? currentChannel.chatroomId,
    viewerCount: nextChannel.viewerCount ?? currentChannel.viewerCount,
    streamTitle: nextChannel.streamTitle ?? currentChannel.streamTitle,
    categoryName: nextChannel.categoryName ?? currentChannel.categoryName,
    tags: nextChannel.tags.length > 0 ? nextChannel.tags : currentChannel.tags,
  };
}

function mergeDiscoveredChannels(
  followedChannels: FollowedChannel[],
  trackedChannels: FollowedChannel[],
  trackedChannelSlugs: string[],
) {
  const mergedChannels = new Map<string, FollowedChannel>();

  for (const channel of [...followedChannels, ...trackedChannels]) {
    const normalizedSlug = channel.channelSlug.trim().toLowerCase();
    if (!normalizedSlug) {
      continue;
    }

    mergedChannels.set(
      normalizedSlug,
      mergeDiscoveredChannel(mergedChannels.get(normalizedSlug), {
        ...channel,
        channelSlug: normalizedSlug,
      }),
    );
  }

  return sortTrackedChannels([...mergedChannels.values()], trackedChannelSlugs);
}

function parseSerializedBadge(value: string): ChannelChatBadge | null {
  const typeMatch = value.match(/type=([^;}]*)/i);
  const textMatch = value.match(/text=([^;}]*)/i);
  const countMatch = value.match(/count=([^;}]*)/i);
  const imageMatch = value.match(/(?:imageUrl|image_url|image|iconUrl|icon_url|icon|src|srcset|url|badgeImageUrl|badge_image_url|badgeUrl|badge_url|original|originalUrl|original_url|fullsize|fullSize|full_size)=([^;}]*)/i);
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
    imageUrl: normalizeBadgeImageUrlCandidate(imageMatch?.[1] ?? null)
  };
}

function normalizeBadgeImageUrlCandidate(value: unknown) {
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
}

function resolveNestedBadgeImageUrl(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const directMatch = [
    record.url,
    record.src,
    record.srcUrl,
    record.src_url,
    record.original,
    record.originalUrl,
    record.original_url,
    record.fullsize,
    record.fullSize,
    record.full_size
  ]
    .map((candidate) => normalizeBadgeImageUrlCandidate(candidate))
    .find((candidate): candidate is string => candidate !== null);

  if (directMatch) {
    return directMatch;
  }

  return normalizeBadgeImageUrlCandidate(record.srcset)
    ?? normalizeBadgeImageUrlCandidate(record.srcSet);
}

function resolveBadgeImageUrl(value: Record<string, unknown>) {
  const candidates = [
    value.image,
    resolveNestedBadgeImageUrl(value.image),
    value.image_url,
    value.badgeImage,
    value.badgeImageUrl,
    value.badge_image_url,
    value.badge_image,
    resolveNestedBadgeImageUrl(value.badgeImage),
    resolveNestedBadgeImageUrl(value.badge_image),
    value.icon,
    resolveNestedBadgeImageUrl(value.icon),
    value.icon_url,
    value.src,
    value.srcset,
    value.url,
    value.badgeUrl,
    value.badge_url,
    value.small_icon_url,
    value.thumbnail,
    resolveNestedBadgeImageUrl(value.thumbnail)
  ];

  const match = candidates
    .map((candidate) => normalizeBadgeImageUrlCandidate(candidate))
    .find((candidate): candidate is string => candidate !== null);
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

function getBadgeTypeKey(badge: Pick<ChannelChatBadge, 'type' | 'text'>) {
  return (badge.type || badge.text || 'badge').trim().toLowerCase();
}

function getBadgeVariantKey(badge: Pick<ChannelChatBadge, 'type' | 'text' | 'count'>) {
  return `${getBadgeTypeKey(badge)}:${badge.count ?? 'none'}`;
}

function isOpaqueBadgeValue(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  return !normalizedValue || normalizedValue.startsWith('size-[') || normalizedValue.includes('calc(');
}

function getSenderBadgeCacheKey(sender: Pick<ChannelChatSender, 'id' | 'slug' | 'username'>) {
  const normalizedSlug = sender.slug.trim().toLowerCase();
  if (normalizedSlug) {
    return `slug:${normalizedSlug}`;
  }

  if (sender.id !== null) {
    return `id:${sender.id}`;
  }

  return `username:${sender.username.trim().toLowerCase()}`;
}

function cloneBadge(badge: ChannelChatBadge): ChannelChatBadge {
  return {
    type: badge.type,
    text: badge.text,
    count: badge.count,
    imageUrl: badge.imageUrl
  };
}

function scoreSenderBadges(badges: ChannelChatBadge[]) {
  return badges.reduce((score, badge, index) => score
    + (badge.imageUrl ? 100 : 0)
    + (!isOpaqueBadgeValue(badge.type) ? 10 : 0)
    + (!isOpaqueBadgeValue(badge.text) ? 5 : 0)
    + Math.max(0, badges.length - index), 0);
}

function findCachedSenderBadges(messages: ChannelChatMessage[], sender: Pick<ChannelChatSender, 'id' | 'slug' | 'username'>) {
  const senderBadgeCacheKey = getSenderBadgeCacheKey(sender);
  let preferredBadges: ChannelChatBadge[] = [];
  let bestScore = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const currentMessage = messages[index];
    if (getSenderBadgeCacheKey(currentMessage.sender) !== senderBadgeCacheKey) {
      continue;
    }

    const currentBadges = currentMessage.sender.badges || [];
    if (currentBadges.length === 0) {
      continue;
    }

    const currentScore = scoreSenderBadges(currentBadges);
    if (currentScore < bestScore) {
      continue;
    }

    preferredBadges = currentBadges.map((badge) => cloneBadge(badge));
    bestScore = currentScore;
  }

  return preferredBadges;
}

function getBadgeTextKey(badge: Pick<ChannelChatBadge, 'text'>) {
  return badge.text.trim().toLowerCase();
}

function findMatchingCachedBadgeIndex(cachedBadges: ChannelChatBadge[], badge: ChannelChatBadge, fallbackIndex: number) {
  const badgeVariantKey = getBadgeVariantKey(badge);
  const badgeTypeKey = getBadgeTypeKey(badge);
  const badgeTextKey = getBadgeTextKey(badge);

  const exactVariantIndex = cachedBadges.findIndex((cachedBadge) => getBadgeVariantKey(cachedBadge) === badgeVariantKey);
  if (exactVariantIndex >= 0) {
    return exactVariantIndex;
  }

  if (!isOpaqueBadgeValue(badge.type)) {
    const typeIndex = cachedBadges.findIndex((cachedBadge) => getBadgeTypeKey(cachedBadge) === badgeTypeKey);
    if (typeIndex >= 0) {
      return typeIndex;
    }
  }

  if (!isOpaqueBadgeValue(badge.text)) {
    const textIndex = cachedBadges.findIndex((cachedBadge) => getBadgeTextKey(cachedBadge) === badgeTextKey);
    if (textIndex >= 0) {
      return textIndex;
    }
  }

  return fallbackIndex < cachedBadges.length ? fallbackIndex : -1;
}

function mergeBadgeWithCachedBadge(badge: ChannelChatBadge, cachedBadge: ChannelChatBadge | null) {
  if (!cachedBadge) {
    return cloneBadge(badge);
  }

  return {
    type: !isOpaqueBadgeValue(badge.type) ? badge.type : cachedBadge.type,
    text: !isOpaqueBadgeValue(badge.text) ? badge.text : cachedBadge.text,
    count: badge.count ?? cachedBadge.count,
    imageUrl: badge.imageUrl ?? cachedBadge.imageUrl
  };
}

function hydrateSenderBadgesWithCachedBadges(nextBadges: ChannelChatBadge[], cachedSenderBadges: ChannelChatBadge[]) {
  if (cachedSenderBadges.length === 0) {
    return nextBadges.map((badge) => cloneBadge(badge));
  }

  if (nextBadges.length === 0) {
    return cachedSenderBadges.map((badge) => cloneBadge(badge));
  }

  const matchedCachedBadgeIndexes = new Set<number>();
  const hydratedBadges = nextBadges.map((badge, badgeIndex) => {
    const cachedBadgeIndex = findMatchingCachedBadgeIndex(cachedSenderBadges, badge, badgeIndex);
    if (cachedBadgeIndex >= 0) {
      matchedCachedBadgeIndexes.add(cachedBadgeIndex);
    }

    return mergeBadgeWithCachedBadge(
      badge,
      cachedBadgeIndex >= 0 ? cachedSenderBadges[cachedBadgeIndex] : null
    );
  });

  for (let badgeIndex = 0; badgeIndex < cachedSenderBadges.length; badgeIndex += 1) {
    if (matchedCachedBadgeIndexes.has(badgeIndex)) {
      continue;
    }

    const cachedBadge = cachedSenderBadges[badgeIndex];
    const alreadyIncluded = hydratedBadges.some((badge) => (
      getBadgeVariantKey(badge) === getBadgeVariantKey(cachedBadge)
      || (badge.imageUrl !== null && badge.imageUrl === cachedBadge.imageUrl)
    ));
    if (alreadyIncluded) {
      continue;
    }

    hydratedBadges.push(cloneBadge(cachedBadge));
  }

  return hydratedBadges;
}

function hydrateRealtimeSenderBadges(currentChat: ChannelChat, nextMessage: ChannelChatMessage) {
  const cachedSenderBadges = findCachedSenderBadges(currentChat.messages, nextMessage.sender);
  if (cachedSenderBadges.length === 0) {
    return nextMessage;
  }

  return {
    ...nextMessage,
    sender: {
      ...nextMessage.sender,
      badges: hydrateSenderBadgesWithCachedBadges(nextMessage.sender.badges || [], cachedSenderBadges)
    }
  };
}

function isDomSnapshotMessage(message: Pick<ChannelChatMessage, 'id'>) {
  return message.id.startsWith('dom:');
}

function normalizeChatMessageMatchContent(content: string) {
  return normalizeExternalEmoteCode(content).trim();
}

function getChatMessageTimestampMs(message: Pick<ChannelChatMessage, 'createdAt'>) {
  if (!message.createdAt) {
    return null;
  }

  const timestampMs = Date.parse(message.createdAt);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function areEquivalentChatMessages(leftMessage: ChannelChatMessage, rightMessage: ChannelChatMessage) {
  if (leftMessage.id === rightMessage.id) {
    return true;
  }

  if (isDomSnapshotMessage(leftMessage) === isDomSnapshotMessage(rightMessage)) {
    return false;
  }

  if (getSenderBadgeCacheKey(leftMessage.sender) !== getSenderBadgeCacheKey(rightMessage.sender)) {
    return false;
  }

  if (leftMessage.type !== rightMessage.type) {
    return false;
  }

  if (normalizeChatMessageMatchContent(leftMessage.content) !== normalizeChatMessageMatchContent(rightMessage.content)) {
    return false;
  }

  if (leftMessage.threadParentId && rightMessage.threadParentId && leftMessage.threadParentId !== rightMessage.threadParentId) {
    return false;
  }

  const leftTimestampMs = getChatMessageTimestampMs(leftMessage);
  const rightTimestampMs = getChatMessageTimestampMs(rightMessage);
  if (leftTimestampMs === null || rightTimestampMs === null) {
    return false;
  }

  return Math.abs(leftTimestampMs - rightTimestampMs) <= 65_000;
}

function mergeEquivalentChatMessages(currentMessage: ChannelChatMessage, nextMessage: ChannelChatMessage) {
  const preferredMessage = isDomSnapshotMessage(currentMessage) && !isDomSnapshotMessage(nextMessage)
    ? nextMessage
    : currentMessage;
  const fallbackMessage = preferredMessage === currentMessage ? nextMessage : currentMessage;
  const preferredBadges = hydrateSenderBadgesWithCachedBadges(preferredMessage.sender.badges || [], fallbackMessage.sender.badges || []);
  const fallbackBadges = hydrateSenderBadgesWithCachedBadges(fallbackMessage.sender.badges || [], preferredMessage.sender.badges || []);
  const mergedBadges = scoreSenderBadges(preferredBadges) >= scoreSenderBadges(fallbackBadges)
    ? preferredBadges
    : fallbackBadges;

  return {
    id: preferredMessage.id,
    content: preferredMessage.content.length >= fallbackMessage.content.length ? preferredMessage.content : fallbackMessage.content,
    type: preferredMessage.type !== 'message' ? preferredMessage.type : fallbackMessage.type,
    createdAt: preferredMessage.createdAt ?? fallbackMessage.createdAt,
    threadParentId: preferredMessage.threadParentId ?? fallbackMessage.threadParentId,
    sender: {
      id: preferredMessage.sender.id ?? fallbackMessage.sender.id,
      username: preferredMessage.sender.username || fallbackMessage.sender.username,
      slug: preferredMessage.sender.slug || fallbackMessage.sender.slug,
      color: preferredMessage.sender.color ?? fallbackMessage.sender.color,
      badges: mergedBadges
    }
  };
}

function findMatchingChatMessageIndex(messages: ChannelChatMessage[], nextMessage: ChannelChatMessage) {
  const exactMessageIndex = messages.findIndex((message) => message.id === nextMessage.id);
  if (exactMessageIndex >= 0) {
    return exactMessageIndex;
  }

  return messages.findIndex((message) => areEquivalentChatMessages(message, nextMessage));
}

function buildBadgeImageUrlIndex(messages: ChannelChatMessage[]) {
  const badgeImageUrlIndex = new Map<string, string>();

  for (const message of messages) {
    for (const badge of message.sender.badges || []) {
      if (!badge.imageUrl) {
        continue;
      }

      const variantKey = getBadgeVariantKey(badge);
      if (!badgeImageUrlIndex.has(variantKey)) {
        badgeImageUrlIndex.set(variantKey, badge.imageUrl);
      }

      const typeKey = getBadgeTypeKey(badge);
      if (!badgeImageUrlIndex.has(typeKey)) {
        badgeImageUrlIndex.set(typeKey, badge.imageUrl);
      }
    }
  }

  return badgeImageUrlIndex;
}

function resolveCachedBadgeImageUrl(badge: ChannelChatBadge, badgeImageUrlIndex: Map<string, string>) {
  return badgeImageUrlIndex.get(getBadgeVariantKey(badge))
    ?? badgeImageUrlIndex.get(getBadgeTypeKey(badge))
    ?? null;
}

function renderSenderBadge(badge: ChannelChatBadge, key: string, badgeImageUrlIndex: Map<string, string>) {
  const imageUrl = badge.imageUrl || resolveCachedBadgeImageUrl(badge, badgeImageUrlIndex);
  if (imageUrl) {
    return <img className="chat-badge-icon chat-badge-image" key={key} src={imageUrl} alt={getBadgeTitle(badge)} title={getBadgeTitle(badge)} loading="lazy" decoding="async" draggable={false} />;
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

  const hydratedRealtimeMessage = hydrateRealtimeSenderBadges(currentChat, nextMessage);
  const matchingMessageIndex = findMatchingChatMessageIndex(currentChat.messages, hydratedRealtimeMessage);

  if (matchingMessageIndex >= 0) {
    const nextMessages = [...currentChat.messages];
    nextMessages[matchingMessageIndex] = mergeEquivalentChatMessages(nextMessages[matchingMessageIndex], hydratedRealtimeMessage);

    return {
      ...currentChat,
      messages: nextMessages,
      updatedAt: new Date().toISOString()
    };
  }

  const nextMessages = currentChat.messages.length >= 200
    ? [...currentChat.messages.slice(-199), hydratedRealtimeMessage]
    : [...currentChat.messages, hydratedRealtimeMessage];

  return {
    ...currentChat,
    messages: nextMessages,
    updatedAt: new Date().toISOString()
  };
}

function realtimeMessageNeedsBadgeRefresh(currentChat: ChannelChat | null, nextMessage: ChannelChatMessage) {
  if (!currentChat) {
    return false;
  }

  const hydratedRealtimeMessage = hydrateRealtimeSenderBadges(currentChat, nextMessage);
  const badgeImageUrlIndex = buildBadgeImageUrlIndex(currentChat.messages);

  return hydratedRealtimeMessage.sender.badges.some((badge) => !badge.imageUrl && !resolveCachedBadgeImageUrl(badge, badgeImageUrlIndex));
}

function mergeChannelChat(currentChat: ChannelChat | null, nextChat: ChannelChat): ChannelChat {
  if (!currentChat || currentChat.channelSlug !== nextChat.channelSlug) {
    return nextChat;
  }

  const mergedMessages = [...nextChat.messages];

  for (const message of currentChat.messages) {
    const matchingMessageIndex = findMatchingChatMessageIndex(mergedMessages, message);
    if (matchingMessageIndex >= 0) {
      mergedMessages[matchingMessageIndex] = mergeEquivalentChatMessages(message, mergedMessages[matchingMessageIndex]);
      continue;
    }

    mergedMessages.push(message);
  }

  return {
    ...currentChat,
    ...nextChat,
    channelUserId: nextChat.channelUserId ?? currentChat.channelUserId,
    pinnedMessage: nextChat.pinnedMessage || currentChat.pinnedMessage,
    messages: mergedMessages.slice(-200)
  };
}

interface OpenChatTabState {
  channel: FollowedChannel;
  chat: ChannelChat | null;
  isLoadingChat: boolean;
  isSendingChat: boolean;
  chatError: string | null;
  sendChatError: string | null;
  liveChatState: LiveChatState;
  liveChatError: string | null;
  draft: string;
}

type OpenChatTabStateRecord = Record<string, OpenChatTabState>;

function createOpenChatTabState(channel: FollowedChannel): OpenChatTabState {
  return {
    channel,
    chat: null,
    isLoadingChat: false,
    isSendingChat: false,
    chatError: null,
    sendChatError: null,
    liveChatState: 'idle',
    liveChatError: null,
    draft: ''
  };
}

function mergeOpenChatTabChannel(currentChannel: FollowedChannel, nextChannel: FollowedChannel): FollowedChannel {
  return {
    channelSlug: nextChannel.channelSlug || currentChannel.channelSlug,
    displayName: nextChannel.displayName || currentChannel.displayName,
    isLive: currentChannel.isLive || nextChannel.isLive,
    channelUrl: nextChannel.channelUrl || currentChannel.channelUrl,
    chatUrl: nextChannel.chatUrl || currentChannel.chatUrl,
    thumbnailUrl: nextChannel.thumbnailUrl ?? currentChannel.thumbnailUrl,
    broadcasterUserId: nextChannel.broadcasterUserId ?? currentChannel.broadcasterUserId,
    channelId: nextChannel.channelId ?? currentChannel.channelId,
    chatroomId: nextChannel.chatroomId ?? currentChannel.chatroomId,
    viewerCount: nextChannel.viewerCount ?? currentChannel.viewerCount,
    streamTitle: nextChannel.streamTitle ?? currentChannel.streamTitle,
    categoryName: nextChannel.categoryName ?? currentChannel.categoryName,
    tags: nextChannel.tags.length > 0 ? nextChannel.tags : currentChannel.tags,
  };
}

function mergeOpenChatChannelChat(currentChat: ChannelChat | null, channel: FollowedChannel) {
  if (!currentChat || currentChat.channelSlug !== channel.channelSlug) {
    return currentChat;
  }

  return {
    ...currentChat,
    channelId: channel.channelId ?? currentChat.channelId,
    channelUserId: channel.broadcasterUserId ?? currentChat.channelUserId,
    chatroomId: channel.chatroomId ?? currentChat.chatroomId,
    displayName: channel.displayName,
    channelUrl: channel.channelUrl,
    avatarUrl: channel.thumbnailUrl ?? currentChat.avatarUrl
  };
}

function updateOpenChatTabState(
  currentTabs: OpenChatTabStateRecord,
  channelSlug: string,
  updater: (currentTab: OpenChatTabState) => OpenChatTabState,
) {
  const currentTab = currentTabs[channelSlug];
  if (!currentTab) {
    return currentTabs;
  }

  const nextTab = updater(currentTab);
  if (nextTab === currentTab) {
    return currentTabs;
  }

  return {
    ...currentTabs,
    [channelSlug]: nextTab
  };
}

function removeRecordEntry<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) {
    return record;
  }

  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

function getRealtimeTargetForTab(tab: OpenChatTabState): RealtimeChatTarget {
  const chatroomId = tab.chat?.chatroomId ?? tab.channel.chatroomId ?? null;

  return {
    channelId: chatroomId === null ? null : (tab.chat?.channelId ?? tab.channel.channelId ?? null),
    chatroomId
  };
}

function channelChatHasMissingBadgeAssets(chat: ChannelChat | null) {
  if (!chat) {
    return false;
  }

  const badgeImageUrlIndex = buildBadgeImageUrlIndex(chat.messages);
  return chat.messages.some((message) => (message.sender.badges || []).some(
    (badge) => !badge.imageUrl && !resolveCachedBadgeImageUrl(badge, badgeImageUrlIndex)
  ));
}

function channelChatNeedsSnapshotEnrichment(chat: ChannelChat | null) {
  if (!chat) {
    return false;
  }

  return chat.chatroomId === null || channelChatHasMissingBadgeAssets(chat);
}

function appendRealtimeChatMessageToTabs(
  currentTabs: OpenChatTabStateRecord,
  entries: Array<{ channelSlug: string; target: RealtimeChatTarget }>,
  nextMessage: ChannelChatMessage,
) {
  let nextTabs = currentTabs;

  for (const entry of entries) {
    const currentTab = nextTabs[entry.channelSlug] ?? currentTabs[entry.channelSlug];
    if (!currentTab?.chat) {
      continue;
    }

    const nextChat = appendRealtimeChatMessage(currentTab.chat, entry.target, nextMessage);
    if (nextChat === currentTab.chat) {
      continue;
    }

    if (nextTabs === currentTabs) {
      nextTabs = { ...currentTabs };
    }

    nextTabs[entry.channelSlug] = {
      ...currentTab,
      chat: nextChat
    };
  }

  return nextTabs;
}

export default function App() {
  const [bridgeStatus, setBridgeStatus] = useState<KickBridgeStatus>(FALLBACK_STATUS);
  const [channels, setChannels] = useState<FollowedChannel[]>([]);
  const [trackedChannelSlugs, setTrackedChannelSlugs] = useState<string[]>([]);
  const [trackedChannelDraft, setTrackedChannelDraft] = useState('');
  const [openChatTabSlugs, setOpenChatTabSlugs] = useState<string[]>([]);
  const [activeChatTabSlug, setActiveChatTabSlug] = useState<string | null>(null);
  const [openChatTabs, setOpenChatTabs] = useState<OpenChatTabStateRecord>({});
  const [globalEmoteIndex, setGlobalEmoteIndex] = useState<Record<string, ChannelChatEmote>>({});
  const [channelEmoteCache, setChannelEmoteCache] = useState<Record<string, ChannelEmoteCacheEntry>>({});
  const [isStartingBridge, setIsStartingBridge] = useState(false);
  const [isLoadingChannels, setIsLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState('Kick token mode is idle. Connect Kick once and the app will keep using the saved token until it expires.');
  const [requiresBrowserReconnect, setRequiresBrowserReconnect] = useState(false);
  const [lastLoadedUsername, setLastLoadedUsername] = useState('');
  const openChatTabsRef = useRef<OpenChatTabStateRecord>({});
  const openChatRefreshInFlightRef = useRef(new Set<string>());
  const chatRequestsInFlightRef = useRef(new Map<string, Promise<ChannelChat>>());
  const lastRealtimeBadgeRefreshAtRef = useRef(new Map<string, number>());
  const lastSnapshotEnrichmentAtRef = useRef(new Map<string, number>());
  const emoteRequestsInFlightRef = useRef(new Set<string>());
  const chatFeedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refreshBridgeStatus();
    void preloadGlobalEmotes();

    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('auth');
    const authMessage = params.get('message');
    const storedTrackedChannels = window.localStorage.getItem(TRACKED_CHANNELS_STORAGE_KEY);
    if (storedTrackedChannels) {
      setTrackedChannelSlugs(parseTrackedChannelSlugs(storedTrackedChannels));
    }

    if (authResult === 'success') {
      setActivity(authMessage || TOKEN_ONLY_ACTIVITY_MESSAGE);
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

  useEffect(() => {
    if (trackedChannelSlugs.length === 0) {
      window.localStorage.removeItem(TRACKED_CHANNELS_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(TRACKED_CHANNELS_STORAGE_KEY, serializeTrackedChannelSlugs(trackedChannelSlugs));
  }, [trackedChannelSlugs]);

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

  useEffect(() => {
    openChatTabsRef.current = openChatTabs;
  }, [openChatTabs]);

  function rememberOpenChatChannel(channel: FollowedChannel) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => {
        const currentTab = currentTabs[channel.channelSlug];
        if (!currentTab) {
          return {
            ...currentTabs,
            [channel.channelSlug]: createOpenChatTabState(channel)
          };
        }

        const nextChannel = mergeOpenChatTabChannel(currentTab.channel, channel);
        const nextChat = mergeOpenChatChannelChat(currentTab.chat, nextChannel);

        return {
          ...currentTabs,
          [channel.channelSlug]: {
            ...currentTab,
            channel: nextChannel,
            chat: nextChat
          }
        };
      });
    });
  }

  function setChatDraftForChannel(channelSlug: string, draft: string) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        draft
      })));
    });
  }

  function setChatErrorForChannel(channelSlug: string, nextChatError: string | null) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        chatError: nextChatError
      })));
    });
  }

  function setSendChatErrorForChannel(channelSlug: string, nextSendChatError: string | null) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        sendChatError: nextSendChatError
      })));
    });
  }

  function setLiveChatStateForChannel(channelSlug: string, nextLiveChatState: LiveChatState, nextLiveChatError: string | null = null) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        liveChatState: nextLiveChatState,
        liveChatError: nextLiveChatError
      })));
    });
  }

  function setLoadingChatForChannel(channelSlug: string, nextIsLoadingChat: boolean) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        isLoadingChat: nextIsLoadingChat
      })));
    });
  }

  function setSendingChatForChannel(channelSlug: string, nextIsSendingChat: boolean) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        isSendingChat: nextIsSendingChat
      })));
    });
  }

  function updateOpenChannelChat(channelSlug: string, updater: (currentChat: ChannelChat | null) => ChannelChat | null) {
    startTransition(() => {
      setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, channelSlug, (currentTab) => ({
        ...currentTab,
        chat: updater(currentTab.chat)
      })));
    });
  }

  function getOpenChatChannel(channelSlug: string) {
    return openChatTabsRef.current[channelSlug]?.channel
      ?? channels.find((channel) => channel.channelSlug === channelSlug)
      ?? null;
  }

  async function loadChannelChatSnapshot(channel: FollowedChannel, options: { forceFull?: boolean } = {}) {
    const currentTab = openChatTabsRef.current[channel.channelSlug];
    const resolvedChannelId = currentTab?.chat?.channelId ?? currentTab?.channel.channelId ?? channel.channelId;
    const resolvedChannelUserId = currentTab?.chat?.channelUserId ?? currentTab?.channel.broadcasterUserId ?? channel.broadcasterUserId;
    const resolvedDisplayName = currentTab?.chat?.displayName ?? currentTab?.channel.displayName ?? channel.displayName;
    const resolvedAvatarUrl = currentTab?.chat?.avatarUrl ?? currentTab?.channel.thumbnailUrl ?? channel.thumbnailUrl;
    const requestMode = options.forceFull || resolvedChannelId === null ? 'full' : 'fast';
    const requestKey = `${channel.channelSlug}:${requestMode}`;
    const existingRequest = chatRequestsInFlightRef.current.get(requestKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = fetchChannelChat({
      channelSlug: channel.channelSlug,
      channelId: resolvedChannelId,
      channelUserId: resolvedChannelUserId,
      displayName: resolvedDisplayName,
      avatarUrl: resolvedAvatarUrl,
      fast: requestMode === 'fast'
    }).finally(() => {
      chatRequestsInFlightRef.current.delete(requestKey);
    });

    chatRequestsInFlightRef.current.set(requestKey, request);
    return request;
  }

  function activateChatTab(channelSlug: string) {
    if (activeChatTabSlug === channelSlug) {
      return;
    }

    setActiveChatTabSlug(channelSlug);
  }

  function openChatTab(channel: FollowedChannel) {
    rememberOpenChatChannel(channel);
    setOpenChatTabSlugs((currentTabSlugs) => currentTabSlugs.includes(channel.channelSlug)
      ? currentTabSlugs
      : [...currentTabSlugs, channel.channelSlug]);
    activateChatTab(channel.channelSlug);

    const currentTab = openChatTabsRef.current[channel.channelSlug];
    if (!currentTab?.chat || (!currentTab.channel.isLive && channel.isLive)) {
      void loadChannelChat(channel);
    }
  }

  function closeChatTab(channelSlug: string) {
    const currentIndex = openChatTabSlugs.indexOf(channelSlug);
    if (currentIndex < 0) {
      return;
    }

    const nextTabSlugs = openChatTabSlugs.filter((entry) => entry !== channelSlug);

    startTransition(() => {
      setOpenChatTabSlugs(nextTabSlugs);
      setActiveChatTabSlug((currentActiveChatTabSlug) => currentActiveChatTabSlug === channelSlug
        ? nextTabSlugs[currentIndex] ?? nextTabSlugs[currentIndex - 1] ?? null
        : currentActiveChatTabSlug);
      setOpenChatTabs((currentTabs) => removeRecordEntry(currentTabs, channelSlug));
    });

    for (const requestKey of [...openChatRefreshInFlightRef.current]) {
      if (requestKey.startsWith(`${channelSlug}:`)) {
        openChatRefreshInFlightRef.current.delete(requestKey);
      }
    }

    for (const requestKey of [...chatRequestsInFlightRef.current.keys()]) {
      if (requestKey.startsWith(`${channelSlug}:`)) {
        chatRequestsInFlightRef.current.delete(requestKey);
      }
    }

    lastRealtimeBadgeRefreshAtRef.current.delete(channelSlug);
    lastSnapshotEnrichmentAtRef.current.delete(channelSlug);
  }

  const isAuthenticated = bridgeStatus.isAuthenticated && Boolean(bridgeStatus.profile);
  const profile = bridgeStatus.profile;
  const tokenOnlyMode = true;
  const browserChatEnabled = bridgeStatus.hasBrowserSession && !requiresBrowserReconnect;
  const hasChatWriteScope = bridgeStatus.grantedScopes.includes('chat:write');
  const selectedChannelSlug = activeChatTabSlug;
  const activeChatTab = selectedChannelSlug ? openChatTabs[selectedChannelSlug] ?? null : null;
  const selectedChannel = activeChatTab?.channel ?? null;
  const channelChat = activeChatTab?.chat ?? null;
  const isLoadingChat = activeChatTab?.isLoadingChat ?? false;
  const isSendingChat = activeChatTab?.isSendingChat ?? false;
  const chatError = activeChatTab?.chatError ?? null;
  const sendChatError = activeChatTab?.sendChatError ?? null;
  const liveChatState = activeChatTab?.liveChatState ?? 'idle';
  const liveChatError = activeChatTab?.liveChatError ?? null;
  const chatDraft = activeChatTab?.draft ?? '';
  const liveTrackedChannelsCount = channels.filter((channel) => channel.isLive).length;
  const hasChannelDiscoverySource = browserChatEnabled || trackedChannelSlugs.length > 0;
  const liveCountLabel = tokenOnlyMode
    ? !isAuthenticated || !profile
      ? 'Sign in to activate Kick token-only mode.'
      : !hasChannelDiscoverySource
        ? 'Enable the Kick browser sync once or add tracked channel slugs to start loading channels.'
        : liveTrackedChannelsCount === 0
          ? bridgeStatus.hasBrowserSession
            ? trackedChannelSlugs.length === 0
              ? `No live followings are online for ${profile.username} right now.`
              : 'No live followed or tracked channels are online right now.'
            : `No tracked channels are live right now across ${trackedChannelSlugs.length} saved slug${trackedChannelSlugs.length === 1 ? '' : 's'}.`
          : bridgeStatus.hasBrowserSession
            ? trackedChannelSlugs.length === 0
              ? `${liveTrackedChannelsCount} live following channel${liveTrackedChannelsCount === 1 ? '' : 's'} are live right now.`
              : `${liveTrackedChannelsCount} live channel${liveTrackedChannelsCount === 1 ? '' : 's'} are live right now across your followings and watchlist.`
            : `${liveTrackedChannelsCount} tracked channel${liveTrackedChannelsCount === 1 ? '' : 's'} are live right now.`
    : !lastLoadedUsername
      ? isAuthenticated && profile
        ? `No live followings loaded for ${profile.username} yet.`
        : 'Sign in to load your live followings.'
      : channels.length === 0
        ? `No live followings found for ${lastLoadedUsername}.`
        : `${channels.length} live followings found for ${lastLoadedUsername}.`;
  const sessionExpiryLabel = bridgeStatus.tokenExpiresAt
    ? new Date(bridgeStatus.tokenExpiresAt).toLocaleString()
    : 'No Kick token stored';
  const needsBrowserSync = bridgeStatus.oauthEnabled && isAuthenticated && !browserChatEnabled;
  const showReconnectBrowserAction = isAuthenticated && requiresBrowserReconnect;
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
  const badgeImageUrlIndex = buildBadgeImageUrlIndex(channelChat?.messages ?? []);
  const displayedChatMessages = channelChat ? [...channelChat.messages].reverse() : [];
  const newestVisibleMessageId = displayedChatMessages[0]?.id ?? null;
  const activeChatroomId = channelChat?.chatroomId ?? selectedChannel?.chatroomId ?? null;
  const activeRealtimeChannelId = channelChat?.channelId ?? selectedChannel?.channelId ?? null;
  const hasActiveRealtimeTarget = activeChatroomId !== null;
  const selectedChannelSupportsRealtime = Boolean(selectedChannel?.isLive && selectedChannel.chatroomId !== null);
  const selectedChannelRealtimeOnly = tokenOnlyMode && !browserChatEnabled && selectedChannelSupportsRealtime;
  const canSendSelectedChannelChat = Boolean(
    selectedChannel?.isLive &&
    selectedChannel.channelSlug === channelChat?.channelSlug &&
    channelChat?.channelUserId !== null,
  );
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
  const realtimeSubscriptionsKey = openChatTabSlugs.map((channelSlug) => {
    const currentTab = openChatTabs[channelSlug];
    const realtimeTarget = currentTab ? getRealtimeTargetForTab(currentTab) : { channelId: null, chatroomId: null };
    return `${channelSlug}:${realtimeTarget.channelId ?? 'none'}:${realtimeTarget.chatroomId ?? 'none'}`;
  }).join('|');

  useEffect(() => {
    if (!tokenOnlyMode || !isAuthenticated || !hasChannelDiscoverySource) {
      return;
    }

    void loadAvailableChannels({ silent: channels.length > 0 });
  }, [browserChatEnabled, channels.length, hasChannelDiscoverySource, isAuthenticated, tokenOnlyMode, trackedChannelSlugs]);

  useEffect(() => {
    if (!tokenOnlyMode || !isAuthenticated || !hasChannelDiscoverySource) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadAvailableChannels({ silent: true });
    }, 30000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [browserChatEnabled, hasChannelDiscoverySource, isAuthenticated, tokenOnlyMode, trackedChannelSlugs]);

  useEffect(() => {
    if (!isAuthenticated) {
      startTransition(() => {
        setChannels([]);
        setLastLoadedUsername('');
      });
      return;
    }

    if (hasChannelDiscoverySource) {
      return;
    }

    startTransition(() => {
      setChannels([]);
    });
  }, [hasChannelDiscoverySource, isAuthenticated]);

  useEffect(() => {
    if (isBrowserReconnectRequiredMessage(bridgeStatus.message)) {
      setRequiresBrowserReconnect(true);
      return;
    }

    if (!bridgeStatus.hasBrowserSession || bridgeStatus.state === 'RUNNING') {
      setRequiresBrowserReconnect(false);
    }
  }, [bridgeStatus.hasBrowserSession, bridgeStatus.message, bridgeStatus.state]);

  useEffect(() => {
    if (isAuthenticated) {
      return;
    }

    setRequiresBrowserReconnect(false);
    setOpenChatTabSlugs([]);
    setActiveChatTabSlug(null);
    setOpenChatTabs({});
  }, [isAuthenticated]);

  useEffect(() => {
    if (openChatTabSlugs.length === 0 || channels.length === 0) {
      return;
    }

    startTransition(() => {
      setOpenChatTabs((currentTabs) => {
        let nextTabs = currentTabs;

        for (const channelSlug of openChatTabSlugs) {
          const currentTab = currentTabs[channelSlug];
          const nextChannel = channels.find((channel) => channel.channelSlug === channelSlug);
          if (!currentTab || !nextChannel) {
            continue;
          }

          const mergedChannel = mergeOpenChatTabChannel(currentTab.channel, nextChannel);
          const mergedChat = mergeOpenChatChannelChat(currentTab.chat, mergedChannel);

          if (nextTabs === currentTabs) {
            nextTabs = { ...currentTabs };
          }

          nextTabs[channelSlug] = {
            ...currentTab,
            channel: mergedChannel,
            chat: mergedChat
          };
        }

        return nextTabs;
      });
    });
  }, [channels, openChatTabSlugs]);

  useEffect(() => {
    if (!isAuthenticated || openChatTabSlugs.length === 0) {
      return;
    }

    const realtimeEntries = openChatTabSlugs
      .map((channelSlug) => {
        const currentTab = openChatTabs[channelSlug];
        if (!currentTab?.chat) {
          return null;
        }

        const target = getRealtimeTargetForTab(currentTab);
        return {
          channelSlug,
          target,
          displayName: currentTab.chat.displayName || currentTab.channel.displayName,
          subscriptionNames: getRealtimeChannelNames(target)
        };
      })
      .filter((entry): entry is {
        channelSlug: string;
        target: RealtimeChatTarget;
        displayName: string;
        subscriptionNames: string[];
      } => entry !== null);

    if (realtimeEntries.length === 0) {
      return;
    }

    startTransition(() => {
      setOpenChatTabs((currentTabs) => {
        let nextTabs = currentTabs;

        for (const entry of realtimeEntries) {
          const currentTab = currentTabs[entry.channelSlug];
          if (!currentTab) {
            continue;
          }

          const nextTab = entry.subscriptionNames.length === 0
            ? {
                ...currentTab,
                liveChatState: 'error' as const,
                liveChatError: 'Kick did not expose a realtime subscription target for this channel.'
              }
            : currentTab.liveChatState === 'live' && currentTab.liveChatError === null
              ? currentTab
              : {
                  ...currentTab,
                  liveChatState: 'connecting' as const,
                  liveChatError: null
                };

          if (nextTab === currentTab) {
            continue;
          }

          if (nextTabs === currentTabs) {
            nextTabs = { ...currentTabs };
          }

          nextTabs[entry.channelSlug] = nextTab;
        }

        return nextTabs;
      });
    });

    const validRealtimeEntries = realtimeEntries.filter((entry) => entry.subscriptionNames.length > 0);
    if (validRealtimeEntries.length === 0) {
      return;
    }

    const subscriptionEntries = new Map<string, Array<{ channelSlug: string; target: RealtimeChatTarget }>>();
    for (const entry of validRealtimeEntries) {
      for (const subscriptionName of entry.subscriptionNames) {
        const currentEntries = subscriptionEntries.get(subscriptionName) ?? [];
        currentEntries.push({
          channelSlug: entry.channelSlug,
          target: entry.target
        });
        subscriptionEntries.set(subscriptionName, currentEntries);
      }
    }

    const pusher = new Pusher(KICK_PUSHER_KEY, KICK_PUSHER_OPTIONS);

    const markLive = (channelSlugs: string[], source: string) => {
      const activeTab = activeChatTabSlug ? openChatTabsRef.current[activeChatTabSlug] ?? null : null;
      const shouldUpdateActivity = Boolean(
        activeTab
        && activeChatTabSlug
        && channelSlugs.includes(activeChatTabSlug)
        && activeTab.liveChatState !== 'live'
      );

      startTransition(() => {
        setOpenChatTabs((currentTabs) => {
          let nextTabs = currentTabs;

          for (const channelSlug of channelSlugs) {
            const currentTab = currentTabs[channelSlug];
            if (!currentTab) {
              continue;
            }

            if (currentTab.liveChatState === 'live' && currentTab.liveChatError === null) {
              continue;
            }

            if (nextTabs === currentTabs) {
              nextTabs = { ...currentTabs };
            }

            nextTabs[channelSlug] = {
              ...currentTab,
              liveChatState: 'live',
              liveChatError: null
            };
          }

          return nextTabs;
        });
      });

      if (shouldUpdateActivity && activeTab) {
        setActivity(`Live chat connected for ${activeTab.chat?.displayName || activeTab.channel.displayName} via ${source}. New Kick messages will appear automatically.`);
      }
    };

    const handleConnectionError = () => {
      startTransition(() => {
        setOpenChatTabs((currentTabs) => {
          let nextTabs = currentTabs;

          for (const entry of validRealtimeEntries) {
            const currentTab = currentTabs[entry.channelSlug];
            if (!currentTab) {
              continue;
            }

            if (
              currentTab.liveChatState === 'error'
              && currentTab.liveChatError === 'Live chat disconnected. You can still refresh chat manually.'
            ) {
              continue;
            }

            if (nextTabs === currentTabs) {
              nextTabs = { ...currentTabs };
            }

            nextTabs[entry.channelSlug] = {
              ...currentTab,
              liveChatState: 'error',
              liveChatError: 'Live chat disconnected. You can still refresh chat manually.'
            };
          }

          return nextTabs;
        });
      });
    };

    const subscriptions = Array.from(subscriptionEntries.entries()).map(([subscriptionName, entries]) => {
      const subscription = pusher.subscribe(subscriptionName);

      const handleSubscriptionSucceeded = () => {
        markLive(entries.map((entry) => entry.channelSlug), subscriptionName);
      };

      const handleRealtimePayload = (source: string, payload: unknown) => {
        const nextMessage = normalizeRealtimeChatMessage(payload);
        if (!nextMessage) {
          return;
        }

        markLive(entries.map((entry) => entry.channelSlug), source);

        startTransition(() => {
          setOpenChatTabs((currentTabs) => appendRealtimeChatMessageToTabs(currentTabs, entries, nextMessage));
        });

        if (activeChatTabSlug && entries.some((entry) => entry.channelSlug === activeChatTabSlug)) {
          void refreshOpenChatForMissingBadgeAssets(activeChatTabSlug, nextMessage);
        }
      };

      const handleGlobalEvent = (eventName: string, payload: unknown) => {
        if (eventName.startsWith('pusher:')) {
          return;
        }

        handleRealtimePayload(`${subscriptionName} · ${eventName}`, payload);
      };

      const handleChatMessage = (payload: unknown) => {
        handleRealtimePayload(`${subscriptionName} · App\\Events\\ChatMessageEvent`, payload);
      };

      subscription.bind('pusher:subscription_succeeded', handleSubscriptionSucceeded);
      subscription.bind_global(handleGlobalEvent);
      subscription.bind('App\\Events\\ChatMessageEvent', handleChatMessage);
      subscription.bind('ChatMessageEvent', handleChatMessage);

      return {
        subscription,
        subscriptionName,
        handleSubscriptionSucceeded,
        handleGlobalEvent,
        handleChatMessage
      };
    });

    pusher.connection.bind('error', handleConnectionError);

    return () => {
      for (const { subscription, subscriptionName, handleSubscriptionSucceeded, handleGlobalEvent, handleChatMessage } of subscriptions) {
        subscription.unbind('pusher:subscription_succeeded', handleSubscriptionSucceeded);
        subscription.unbind('App\\Events\\ChatMessageEvent', handleChatMessage);
        subscription.unbind('ChatMessageEvent', handleChatMessage);
        subscription.unbind_global(handleGlobalEvent);
        pusher.unsubscribe(subscriptionName);
      }

      pusher.connection.unbind('error', handleConnectionError);
      pusher.disconnect();
    };
  }, [activeChatTabSlug, browserChatEnabled, isAuthenticated, openChatTabSlugs, realtimeSubscriptionsKey]);

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

  const refreshOpenChat = useEffectEvent(async (channelSlug: string, options: { forceFull?: boolean } = {}) => {
    if (!browserChatEnabled || !isAuthenticated) {
      return;
    }

    const channel = getOpenChatChannel(channelSlug);
    if (!channel) {
      return;
    }

    const refreshKey = `${channelSlug}:${options.forceFull ? 'full' : 'fast'}`;
    if (openChatRefreshInFlightRef.current.has(refreshKey)) {
      return;
    }

    openChatRefreshInFlightRef.current.add(refreshKey);

    try {
      const nextChat = await loadChannelChatSnapshot(channel, { forceFull: options.forceFull });

      rememberOpenChatChannel({
        ...channel,
        displayName: nextChat.displayName || channel.displayName,
        thumbnailUrl: nextChat.avatarUrl ?? channel.thumbnailUrl,
        broadcasterUserId: nextChat.channelUserId ?? channel.broadcasterUserId,
        channelId: nextChat.channelId ?? channel.channelId,
        chatroomId: nextChat.chatroomId ?? channel.chatroomId,
        channelUrl: nextChat.channelUrl || channel.channelUrl,
        chatUrl: channel.chatUrl ?? nextChat.channelUrl
      });

      updateOpenChannelChat(channelSlug, (currentChat) => currentChat?.channelSlug === nextChat.channelSlug
        ? mergeChannelChat(currentChat, nextChat)
        : nextChat);
    } catch {
      const currentTab = openChatTabsRef.current[channelSlug];
      if (currentTab?.liveChatState !== 'live') {
        setLiveChatStateForChannel(channelSlug, 'error', 'Live chat is delayed. Recent messages are still syncing automatically in the background.');
      }
    } finally {
      openChatRefreshInFlightRef.current.delete(refreshKey);
    }
  });

  const refreshOpenChatForMissingBadgeAssets = useEffectEvent(async (channelSlug: string, nextMessage: ChannelChatMessage) => {
    const currentChat = openChatTabsRef.current[channelSlug]?.chat ?? null;
    if (!realtimeMessageNeedsBadgeRefresh(currentChat, nextMessage)) {
      return;
    }

    const now = Date.now();
    const lastRefreshAt = lastRealtimeBadgeRefreshAtRef.current.get(channelSlug) ?? 0;
    if (now - lastRefreshAt < 2500) {
      return;
    }

    lastRealtimeBadgeRefreshAtRef.current.set(channelSlug, now);
    await refreshOpenChat(channelSlug, { forceFull: true });
  });

  useEffect(() => {
    if (!browserChatEnabled || !isAuthenticated || !selectedChannelSlug || !activeChatTab?.chat || activeChatTab.isLoadingChat) {
      return;
    }

    if (!channelChatNeedsSnapshotEnrichment(activeChatTab.chat)) {
      return;
    }

    const now = Date.now();
    const lastEnrichmentAt = lastSnapshotEnrichmentAtRef.current.get(selectedChannelSlug) ?? 0;
    if (now - lastEnrichmentAt < 15000) {
      return;
    }

    lastSnapshotEnrichmentAtRef.current.set(selectedChannelSlug, now);
    void refreshOpenChat(selectedChannelSlug, { forceFull: true });
  }, [activeChatTab?.chat, activeChatTab?.isLoadingChat, browserChatEnabled, isAuthenticated, selectedChannelSlug]);

  useEffect(() => {
    const feedElement = chatFeedRef.current;
    if (!feedElement) {
      return;
    }

    feedElement.scrollTop = 0;
  }, [newestVisibleMessageId, selectedChannelSlug]);

  function handleReconnectOAuth() {
    window.location.assign(getOAuthLoginUrl());
  }

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

  async function handleStartBridge(forceReconnect = false) {
    if (!isAuthenticated) {
      handleReconnectOAuth();
      return;
    }

    setIsStartingBridge(true);
    setError(null);

    try {
      const nextStatus = await startBridge(forceReconnect);
      startTransition(() => {
        setBridgeStatus(nextStatus);
        setRequiresBrowserReconnect(false);
        setActivity(
          forceReconnect
            ? nextStatus.state === 'READY'
              ? 'Kick browser session is already connected. Retry followings or chat.'
              : 'The Kick browser reconnect window was opened. Keep it open, then retry followings or chat.'
            : 'The Kick browser sync window was opened. Finish the website login there, keep that browser open, then retry chat.'
        );
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to start the Kick login bridge.');
    } finally {
      setIsStartingBridge(false);
    }
  }

  async function ensureBrowserSessionForWebsiteData(featureLabel: string) {
    if (browserChatEnabled || !bridgeStatus.oauthEnabled) {
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
        setRequiresBrowserReconnect(false);
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Failed to start the Kick website session sync.');
    } finally {
      setIsStartingBridge(false);
    }
  }

  function handleAddTrackedChannels() {
    const nextTrackedChannelSlugs = parseTrackedChannelSlugs(trackedChannelDraft);
    if (nextTrackedChannelSlugs.length === 0) {
      return;
    }

    startTransition(() => {
      setTrackedChannelSlugs((currentTrackedChannelSlugs) => [...new Set([...currentTrackedChannelSlugs, ...nextTrackedChannelSlugs])]);
      setTrackedChannelDraft('');
      setError(null);
      setActivity(
        nextTrackedChannelSlugs.length === 1
          ? `Added ${nextTrackedChannelSlugs[0]} to your local Kick watchlist.`
          : `Added ${nextTrackedChannelSlugs.length} channel slugs to your local Kick watchlist.`
      );
    });
  }

  function handleRemoveTrackedChannel(channelSlug: string) {
    startTransition(() => {
      setTrackedChannelSlugs((currentTrackedChannelSlugs) => currentTrackedChannelSlugs.filter((entry) => entry !== channelSlug));
      setActivity(`Removed ${channelSlug} from your local Kick watchlist.`);
    });

    if (openChatTabSlugs.includes(channelSlug)) {
      closeChatTab(channelSlug);
    }
  }

  async function loadAvailableChannels(options: { silent?: boolean } = {}) {
    const { silent = false } = options;

    if (!isAuthenticated || !profile) {
      if (!silent) {
        setError('Connect Kick first so the app can use your saved session.');
      }

      return;
    }

    if (!browserChatEnabled && trackedChannelSlugs.length === 0) {
      if (!silent) {
        setError('Enable the Kick browser sync once or add at least one tracked channel slug first.');
        setActivity('Kick OAuth is connected. Add channel slugs like xqc or shroud, or enable the browser sync to load your live followings too.');
        setChannels([]);
      }

      return;
    }

    if (!silent) {
      setIsLoadingChannels(true);
      setError(null);
    }

    try {
      const [followedChannelsResult, trackedChannelsResult] = await Promise.allSettled([
        browserChatEnabled
          ? fetchLiveFollowedChannels()
          : Promise.resolve<FollowedChannel[]>([]),
        trackedChannelSlugs.length > 0
          ? fetchTrackedChannels(trackedChannelSlugs)
          : Promise.resolve<FollowedChannel[]>([]),
      ]);

      const followedChannels = followedChannelsResult.status === 'fulfilled'
        ? followedChannelsResult.value
        : [];
      const trackedChannels = trackedChannelsResult.status === 'fulfilled'
        ? trackedChannelsResult.value
        : [];

      if (followedChannelsResult.status === 'rejected' && trackedChannelsResult.status === 'rejected') {
        throw followedChannelsResult.reason instanceof Error
          ? followedChannelsResult.reason
          : trackedChannelsResult.reason instanceof Error
            ? trackedChannelsResult.reason
            : new Error('Failed to load Kick channels.');
      }

      const loadedChannels = mergeDiscoveredChannels(followedChannels, trackedChannels, trackedChannelSlugs);
      const nextLiveTrackedChannelsCount = loadedChannels.filter((channel) => channel.isLive).length;
      const hasFollowedChannelsFailure = followedChannelsResult.status === 'rejected';
      const hasTrackedChannelsFailure = trackedChannelsResult.status === 'rejected';
      const followedChannelsErrorMessage = hasFollowedChannelsFailure && followedChannelsResult.reason instanceof Error
        ? followedChannelsResult.reason.message
        : null;
      const trackedChannelsErrorMessage = hasTrackedChannelsFailure && trackedChannelsResult.reason instanceof Error
        ? trackedChannelsResult.reason.message
        : null;

      if (followedChannelsErrorMessage && isBrowserReconnectRequiredMessage(followedChannelsErrorMessage)) {
        setRequiresBrowserReconnect(true);
      }

      startTransition(() => {
        setChannels(loadedChannels);
        setLastLoadedUsername(profile.username);
        setError(null);

        if (!silent) {
          setActivity(
            hasFollowedChannelsFailure && followedChannels.length === 0 && trackedChannels.length > 0
              ? `Loaded your local watchlist, but live followings were unavailable: ${followedChannelsErrorMessage}`
              : hasTrackedChannelsFailure && followedChannels.length > 0
                ? `Loaded ${followedChannels.length} live following channel${followedChannels.length === 1 ? '' : 's'}. Extra watchlist entries were unavailable: ${trackedChannelsErrorMessage}`
                : nextLiveTrackedChannelsCount === 0
                  ? browserChatEnabled
                    ? trackedChannelSlugs.length > 0
                      ? 'No live followed or tracked channels are online right now.'
                      : `No live followings found for ${profile.username}.`
                    : `None of your ${trackedChannelSlugs.length} tracked channels are live right now.`
                  : browserChatEnabled && trackedChannelSlugs.length > 0
                    ? `Loaded ${nextLiveTrackedChannelsCount} live channel${nextLiveTrackedChannelsCount === 1 ? '' : 's'} across your followings and watchlist.`
                    : browserChatEnabled
                      ? `Loaded ${nextLiveTrackedChannelsCount} live following channel${nextLiveTrackedChannelsCount === 1 ? '' : 's'} for ${profile.username}.`
                      : `Loaded ${nextLiveTrackedChannelsCount} live tracked channel${nextLiveTrackedChannelsCount === 1 ? '' : 's'} from your local watchlist.`
          );
        }
      });
    } catch (caughtError) {
        const message = caughtError instanceof Error ? caughtError.message : 'Failed to load Kick channels.';
      if (!silent) {
        setError(message);
      }

      if (isBrowserReconnectRequiredMessage(message)) {
        setRequiresBrowserReconnect(true);
        setActivity('Kick browser sync is offline. Click Reconnect Kick browser, leave that window open, then retry followings or chat.');
        if (!isSecurityPolicyBlockedMessage(message)) {
          await refreshBridgeStatus();
        }
      }
    } finally {
      if (!silent) {
        setIsLoadingChannels(false);
      }
    }
  }

  async function handleLoadChannels() {
    if (!isAuthenticated || !profile) {
      setError('Connect Kick first so the app can use your saved session.');
      return;
    }

    if (tokenOnlyMode) {
      await loadAvailableChannels();
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
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to load live followings.';
      setError(message);
      if (isBrowserReconnectRequiredMessage(message)) {
        setRequiresBrowserReconnect(true);
        setActivity('Kick browser sync is offline. Click Reconnect Kick browser, leave that window open, then retry followings.');
        if (!isSecurityPolicyBlockedMessage(message)) {
          await refreshBridgeStatus();
        }
      }
    } finally {
      setIsLoadingChannels(false);
    }
  }

  async function loadChannelChat(channel: FollowedChannel, options: { forceFull?: boolean } = {}) {
    const currentChannel = getOpenChatChannel(channel.channelSlug);
    const resolvedChannel = currentChannel
      ? mergeOpenChatTabChannel(currentChannel, channel)
      : channel;

    rememberOpenChatChannel(resolvedChannel);

    if (!isAuthenticated) {
      setChatErrorForChannel(resolvedChannel.channelSlug, 'Connect Kick first so the app can use your saved session.');
      return;
    }

    if (tokenOnlyMode && !resolvedChannel.isLive) {
      updateOpenChannelChat(resolvedChannel.channelSlug, () => buildTokenOnlyChatShell(resolvedChannel));
      setChatDraftForChannel(resolvedChannel.channelSlug, '');
      setChatErrorForChannel(resolvedChannel.channelSlug, null);
      setSendChatErrorForChannel(resolvedChannel.channelSlug, null);
      setLiveChatStateForChannel(resolvedChannel.channelSlug, 'idle', 'This tracked channel is offline right now. The watchlist will refresh it automatically.');
      setLoadingChatForChannel(resolvedChannel.channelSlug, false);
      setActivity(
        `${resolvedChannel.displayName} is offline right now. Chatterbro will keep refreshing the watchlist automatically.`
      );
      return;
    }

    if (tokenOnlyMode && !browserChatEnabled && resolvedChannel.chatroomId !== null) {
      updateOpenChannelChat(resolvedChannel.channelSlug, () => buildTokenOnlyChatShell(resolvedChannel));
      setChatDraftForChannel(resolvedChannel.channelSlug, '');
      setChatErrorForChannel(resolvedChannel.channelSlug, null);
      setSendChatErrorForChannel(resolvedChannel.channelSlug, null);
      setLiveChatStateForChannel(
        resolvedChannel.channelSlug,
        'connecting',
        'Browser sync is offline. Waiting for new realtime messages for this live channel.'
      );
      setLoadingChatForChannel(resolvedChannel.channelSlug, false);
      setActivity(`Opened realtime-only chat for ${resolvedChannel.displayName}. New messages will appear as soon as Kick emits them.`);
      return;
    }

    if (tokenOnlyMode && !(await ensureBrowserSessionForWebsiteData('live chat'))) {
      updateOpenChannelChat(resolvedChannel.channelSlug, () => buildTokenOnlyChatShell(resolvedChannel));
      setChatDraftForChannel(resolvedChannel.channelSlug, '');
      setChatErrorForChannel(resolvedChannel.channelSlug, null);
      setSendChatErrorForChannel(resolvedChannel.channelSlug, null);
      setLiveChatStateForChannel(
        resolvedChannel.channelSlug,
        'idle',
        'Live chat needs the Kick browser sync. Finish that browser window, keep it open, then reopen chat.'
      );
      setLoadingChatForChannel(resolvedChannel.channelSlug, false);
      return;
    }

    if (!tokenOnlyMode && !(await ensureBrowserSessionForWebsiteData('chat history'))) {
      setLoadingChatForChannel(resolvedChannel.channelSlug, false);
      return;
    }

    setChatErrorForChannel(resolvedChannel.channelSlug, null);
    setSendChatErrorForChannel(resolvedChannel.channelSlug, null);
    setLiveChatStateForChannel(resolvedChannel.channelSlug, 'idle', null);
    setLoadingChatForChannel(resolvedChannel.channelSlug, true);
    updateOpenChannelChat(resolvedChannel.channelSlug, (currentChat) => currentChat ?? buildTokenOnlyChatShell(resolvedChannel));

    try {
      const nextChat = await loadChannelChatSnapshot(resolvedChannel, { forceFull: options.forceFull });

      startTransition(() => {
        setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, resolvedChannel.channelSlug, (currentTab) => ({
          ...currentTab,
          channel: mergeOpenChatTabChannel(currentTab.channel, {
            ...resolvedChannel,
            displayName: nextChat.displayName || resolvedChannel.displayName,
            thumbnailUrl: nextChat.avatarUrl ?? resolvedChannel.thumbnailUrl,
            broadcasterUserId: nextChat.channelUserId ?? resolvedChannel.broadcasterUserId,
            channelId: nextChat.channelId ?? resolvedChannel.channelId,
            chatroomId: nextChat.chatroomId ?? resolvedChannel.chatroomId,
            channelUrl: nextChat.channelUrl || resolvedChannel.channelUrl,
            chatUrl: resolvedChannel.chatUrl ?? nextChat.channelUrl
          }),
          chat: currentTab.chat?.channelSlug === nextChat.channelSlug
            ? mergeChannelChat(currentTab.chat, nextChat)
            : nextChat,
          chatError: null,
          sendChatError: null,
          liveChatState: currentTab.liveChatState === 'live' ? 'live' : 'idle',
          liveChatError: null
        })));
        setActivity(
          nextChat.messages.length === 0
            ? `Loaded chat for ${resolvedChannel.displayName}, but Kick returned no recent messages.`
            : `Loaded ${nextChat.messages.length} recent chat messages for ${resolvedChannel.displayName}.`
        );
      });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Failed to load the selected channel chat.';
      const reconnectRequired = isBrowserReconnectRequiredMessage(message);
      const securityPolicyBlocked = isSecurityPolicyBlockedMessage(message);
      const canFallbackToRealtimeOnly = tokenOnlyMode && resolvedChannel.isLive && resolvedChannel.chatroomId !== null;

      if (reconnectRequired && canFallbackToRealtimeOnly) {
        setRequiresBrowserReconnect(true);
        updateOpenChannelChat(resolvedChannel.channelSlug, (currentChat) => mergeChannelChat(currentChat, buildTokenOnlyChatShell(resolvedChannel)));
        setChatErrorForChannel(resolvedChannel.channelSlug, null);
        setSendChatErrorForChannel(resolvedChannel.channelSlug, null);
        setLiveChatStateForChannel(
          resolvedChannel.channelSlug,
          'connecting',
          securityPolicyBlocked
            ? 'Kick blocked website snapshot reads. Realtime chat will keep listening on the saved chatroom target.'
            : 'Browser sync is offline. Waiting for new realtime messages for this live channel.'
        );
        setActivity(
          securityPolicyBlocked
            ? `Kick blocked website snapshot reads for ${resolvedChannel.displayName}. Switched to realtime-only chat using the saved chatroom target.`
            : `Opened realtime-only chat for ${resolvedChannel.displayName}. New messages will appear as soon as Kick emits them.`
        );
        return;
      }

      setChatErrorForChannel(resolvedChannel.channelSlug, message);
      if (reconnectRequired) {
        setRequiresBrowserReconnect(true);
        setActivity('Kick browser sync is offline. Click Reconnect Kick browser, leave that window open, then retry chat.');
        if (!securityPolicyBlocked) {
          await refreshBridgeStatus();
        }
      }
    } finally {
      setLoadingChatForChannel(resolvedChannel.channelSlug, false);
    }
  }

  async function handleSendChatMessage() {
    if (!selectedChannelSlug || !selectedChannel || !channelChat) {
      return;
    }

    if (!selectedChannel.isLive) {
      setSendChatErrorForChannel(selectedChannelSlug, 'This tracked channel is offline right now.');
      return;
    }

    if (!hasChatWriteScope) {
      setSendChatErrorForChannel(selectedChannelSlug, 'Reconnect Kick with the chat:write scope before sending messages from Chatterbro.');
      return;
    }

    const content = chatDraft.trim();
    if (content.length === 0) {
      setSendChatErrorForChannel(selectedChannelSlug, 'Enter a chat message before sending it.');
      return;
    }

    if (channelChat.channelUserId === null) {
      setSendChatErrorForChannel(selectedChannelSlug, 'Kick did not expose a broadcaster user id for this channel.');
      return;
    }

    setSendingChatForChannel(selectedChannelSlug, true);
    setSendChatErrorForChannel(selectedChannelSlug, null);

    try {
      const response = await sendChannelChatMessage(selectedChannel.channelSlug, {
        content,
        broadcasterUserId: channelChat.channelUserId
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
        setOpenChatTabs((currentTabs) => updateOpenChatTabState(currentTabs, selectedChannelSlug, (currentTab) => ({
          ...currentTab,
          chat: appendLocalChatMessage(currentTab.chat, optimisticMessage),
          draft: ''
        })));
        setActivity(`Sent a chat message to ${selectedChannel.displayName} through Kick's official API.`);
      });
    } catch (caughtError) {
      setSendChatErrorForChannel(selectedChannelSlug, caughtError instanceof Error ? caughtError.message : 'Failed to send the chat message.');
    } finally {
      setSendingChatForChannel(selectedChannelSlug, false);
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
              {senderBadges.length > 0 ? <span className="chat-badge-list">{senderBadges.map((badge, index) => renderSenderBadge(badge, `${message.id}-${badge.type}-${index}`, badgeImageUrlIndex))}</span> : null}
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
          <h1>{tokenOnlyMode ? 'React dashboard for Kick followings, watchlist, and live chat.' : 'React dashboard for a browser-backed Kick bridge.'}</h1>
          <p className="hero-description">
            {tokenOnlyMode
              ? 'The UI stays in React. Kotlin runs the local API. Live followed channels and your tracked watchlist merge into one list, while live chat uses an explicit Kick browser sync because Kick still does not expose chatroom ids publicly.'
              : 'The UI stays in React. Kotlin runs the local API. Kick OAuth handles account connection first, while the browser bridge is only kept for the unsupported followings and chat-read flows.'}
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

          {tokenOnlyMode ? (
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
                    placeholder="xqc, shroud, your-channel-slug"
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
                  <p>Save a few extra channel slugs here and Chatterbro will merge them into the same list as your live followed channels.</p>
                </div>
              )}
            </div>
          ) : null}

          <div className="action-row">
            {!isAuthenticated ? (
              <button className="primary-button" onClick={handleReconnectOAuth} disabled={isStartingBridge || bridgeStatus.state === 'RUNNING'}>
                {tokenOnlyMode
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
                  ? tokenOnlyMode
                    ? 'Opening followings and live chat sync...'
                    : 'Opening Kick browser sync...'
                  : bridgeStatus.state === 'RUNNING'
                    ? tokenOnlyMode
                      ? 'Waiting for followings and live chat sync...'
                      : 'Waiting for website session sync...'
                    : tokenOnlyMode
                      ? 'Enable followings and live chat sync'
                      : 'Enable followings and chat sync'}
              </button>
            ) : showReconnectBrowserAction ? (
              <button className="primary-button" onClick={() => void handleStartBridge(true)} disabled={isStartingBridge || bridgeStatus.state === 'RUNNING'}>
                {isStartingBridge
                  ? 'Opening Kick browser reconnect...'
                  : bridgeStatus.state === 'RUNNING'
                    ? 'Waiting for Kick browser reconnect...'
                    : 'Reconnect Kick browser'}
              </button>
            ) : null}
            <button className="secondary-button" onClick={handleLoadChannels} disabled={isLoadingChannels || !isAuthenticated || (tokenOnlyMode && !hasChannelDiscoverySource && !needsBrowserSync)}>
              {tokenOnlyMode
                ? isLoadingChannels
                  ? 'Refreshing channels...'
                  : hasChannelDiscoverySource
                    ? 'Refresh channels'
                    : needsBrowserSync
                      ? 'Enable followings sync'
                      : 'Add tracked channels first'
                : isLoadingChannels
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
            <strong>{tokenOnlyMode ? 'Session status' : 'Bridge status'}</strong>
            <p>{bridgeStatus.message}</p>
          </div>

          {isAuthenticated ? (
            <div className="message-strip subtle-strip compact-strip">
              <strong>Session expiry</strong>
              <p>{sessionExpiryLabel}</p>
            </div>
          ) : null}

          {tokenOnlyMode && isAuthenticated ? (
            <div className="message-strip subtle-strip">
              <strong>Followings + watchlist</strong>
              <p>Chatterbro merges your live followed channels with any extra slugs saved in the local watchlist. The watchlist still loads through Kick OAuth, while live followings and live chat still depend on the saved browser sync.</p>
            </div>
          ) : null}

          {tokenOnlyMode && isAuthenticated ? (
            <div className="message-strip subtle-strip">
              <strong>Live chat sync</strong>
              <p>{browserChatEnabled ? 'Browser sync is connected. Live followings can refresh automatically, and opening any live channel will load a chat snapshot before switching into realtime updates.' : 'Click Enable followings and live chat sync once, finish the Kick website login there, keep that browser open, then open chat on any live channel.'}</p>
            </div>
          ) : null}

          {tokenOnlyMode && isAuthenticated && !hasChatWriteScope ? (
            <div className="message-strip subtle-strip">
              <strong>Chat sending</strong>
              <p>Your saved token does not include chat:write yet. Reconnect Kick once to grant it, or add chat:write to KICK_OAUTH_SCOPES if you override scopes in .env.</p>
            </div>
          ) : null}

          {needsBrowserSync ? (
            <div className="message-strip subtle-strip">
              <strong>Website data sync</strong>
              <p>Kick OAuth is active, but live followings and recent chat still require one browser-based website session sync because those read endpoints are not yet exposed in the official Public API.</p>
            </div>
          ) : null}

          {showReconnectBrowserAction ? (
            <div className="message-strip subtle-strip">
              <strong>Browser reconnect required</strong>
              <p>Live followings and chat will no longer reopen the Kick browser automatically. Reconnect it explicitly, keep that browser window open, then retry the action you wanted.</p>
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
            <span className="mono-label">{tokenOnlyMode ? 'oauth 2.1' : 'oauth + website sync'}</span>
          </div>

          <ol className="step-list">
            <li>Click <strong>Connect Kick via OAuth</strong>.</li>
            <li>Finish the Kick authorization flow in your browser.</li>
            <li>{tokenOnlyMode ? 'Add a few tracked channel slugs. When you need live chat, run Enable live chat sync once, keep that browser window open, and Chatterbro will read chat through it while still sending through the official API.' : 'If you need live followings or chat history, run the one-time website session sync the first time you load them.'}</li>
          </ol>

          <p className="helper-copy">
            {tokenOnlyMode
              ? 'Tracked channels and chat sending stay on the official API path, but live chat reads need the Kick website session because that is still the only place Chatterbro can reliably resolve the realtime chat target.'
              : 'Kick\'s Public API now covers auth and profile reads cleanly, but followed-channel and chat-history reads still require the browser bridge until official read endpoints exist.'}
          </p>
        </article>
      </section>

      <section className="panel channel-panel">
        <div className="panel-header">
          <div>
            <h2>{tokenOnlyMode ? 'Followings + Watchlist' : 'Live followings'}</h2>
            <p className="subtle-copy">{liveCountLabel}</p>
          </div>
          <span className="mono-label">Kick channels</span>
        </div>

        {channels.length === 0 ? (
          <div className="empty-state">
            <p>{tokenOnlyMode ? 'No followed or tracked channels are loaded yet.' : 'No tracked channels are loaded yet.'}</p>
            <span>{tokenOnlyMode ? 'Enable the browser sync to load your live followings, or add one or more channel slugs above to extend the local watchlist.' : 'Once your Kick session is connected, this panel will list every live followed channel returned by the backend.'}</span>
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
                  <button className="secondary-button" onClick={() => window.open(channel.channelUrl, '_blank', 'noopener,noreferrer')}>
                    Open channel
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => {
                      openChatTab(channel);
                    }}
                    disabled={(!channel.isLive && tokenOnlyMode) || (isLoadingChat && selectedChannelSlug === channel.channelSlug)}
                  >
                    {tokenOnlyMode
                      ? channel.isLive
                        ? selectedChannelSlug === channel.channelSlug
                          ? browserChatEnabled
                            ? 'Live chat open'
                            : channel.chatroomId !== null
                              ? 'Realtime open'
                              : 'Chat sync pending'
                          : openChatTabSlugs.includes(channel.channelSlug)
                            ? 'Switch chat'
                            : browserChatEnabled
                              ? 'Open live chat'
                              : channel.chatroomId !== null
                                ? 'Open realtime chat'
                                : 'Enable live chat'
                        : 'Channel offline'
                      : isLoadingChat && selectedChannelSlug === channel.channelSlug
                        ? 'Loading chat...'
                        : openChatTabSlugs.includes(channel.channelSlug)
                          ? 'Switch chat'
                          : 'Open chat'}
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
              {tokenOnlyMode
                ? selectedChannel
                  ? browserChatEnabled
                    ? `Hybrid chat for ${selectedChannel.displayName}. Chatterbro reads recent and live messages through the Kick browser sync, and can still send through the official chat API.`
                    : selectedChannelRealtimeOnly
                      ? `Realtime chat for ${selectedChannel.displayName} is active from Kick events now. Enable the browser sync only if you also want recent message history and richer channel metadata.`
                      : `Live chat for ${selectedChannel.displayName} needs the Kick browser sync before Chatterbro can read recent website chat history.`
                  : 'Select any live followed or tracked channel. Chatterbro uses the merged channel list for discovery and the Kick browser sync for live chat.'
                : selectedChannel
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

        {openChatTabSlugs.length > 0 ? (
          <div className="chat-tab-strip">
            {openChatTabSlugs.map((channelSlug) => {
              const tab = openChatTabs[channelSlug];
              if (!tab) {
                return null;
              }

              const tabDisplayName = tab.chat?.displayName || tab.channel.displayName;
              const tabAvatarUrl = tab.chat?.avatarUrl ?? tab.channel.thumbnailUrl;
              const isActiveTab = channelSlug === activeChatTabSlug;

              return (
                <div className={`chat-tab${isActiveTab ? ' chat-tab-active' : ''}`} key={channelSlug}>
                  <button className="chat-tab-select" type="button" onClick={() => activateChatTab(channelSlug)}>
                    <span className="chat-tab-avatar">
                      <AvatarMedia imageUrl={tabAvatarUrl} label={tabDisplayName} />
                    </span>
                    <span className="chat-tab-copy">
                      <strong>{tabDisplayName}</strong>
                      <span>{channelSlug}</span>
                    </span>
                    {tab.chat ? <span className="chat-tab-count">{tab.chat.messages.length}</span> : null}
                  </button>
                  <button className="chat-tab-close" type="button" onClick={() => closeChatTab(channelSlug)} aria-label={`Close ${tabDisplayName} chat tab`}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {selectedChannel ? (
          <div className="chat-shell">
            <div className="chat-summary-card">
              <div className="chat-summary-topline">
                <span className="chat-kick-mark">{tokenOnlyMode ? (browserChatEnabled ? 'Kick live chat' : 'Kick chat tools') : 'Kick chat mirror'}</span>
                <span className="chat-transport-pill">
                  {tokenOnlyMode
                    ? activeChatroomId !== null
                      ? `chatroom_${activeChatroomId}`
                      : browserChatEnabled
                        ? 'snapshot sync'
                        : hasChatWriteScope
                          ? 'chat:write ready'
                          : 'reauthorize for chat:write'
                    : activeChatroomId !== null
                      ? `chatroom_${activeChatroomId}`
                      : 'snapshot mode'}
                </span>
              </div>

              <div className="chat-summary-main">
                <div>
                  <div className="channel-identity">
                    <div className="channel-avatar">
                      <AvatarMedia imageUrl={channelChat?.avatarUrl || selectedChannel.thumbnailUrl} label={selectedChannel.displayName} />
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
                  <span>{tokenOnlyMode ? liveChatState === 'live' ? 'Realtime on' : hasActiveRealtimeTarget && selectedChannel.isLive ? 'Realtime ready' : browserChatEnabled ? 'Snapshot sync' : selectedChannelSupportsRealtime ? 'Realtime only' : selectedChannel.isLive ? 'Awaiting sync' : 'Offline' : liveChatState === 'live' ? 'Realtime on' : 'Snapshot sync'}</span>
                </div>
              </div>

              <div className="channel-actions compact-actions chat-toolbar">
                <button className="secondary-button" onClick={() => window.open(selectedChannel.channelUrl, '_blank', 'noopener,noreferrer')}>
                  Open channel
                </button>
                {tokenOnlyMode ? (
                  browserChatEnabled ? (
                    <button className="primary-button" onClick={() => {
                      void loadChannelChat(selectedChannel, { forceFull: true });
                    }} disabled={isLoadingChat}>
                      {isLoadingChat ? 'Refreshing chat...' : 'Refresh chat'}
                    </button>
                  ) : hasActiveRealtimeTarget && selectedChannel.isLive ? (
                    <button className="primary-button" onClick={() => {
                      void loadChannelChat(selectedChannel);
                    }} disabled={isLoadingChat}>
                      {isLoadingChat ? 'Connecting chat...' : 'Reconnect realtime'}
                    </button>
                  ) : (
                    <button className="primary-button" onClick={startBrowserSessionSync} disabled={isStartingBridge || bridgeStatus.state === 'RUNNING'}>
                      {isStartingBridge ? 'Opening live chat sync...' : bridgeStatus.state === 'RUNNING' ? 'Waiting for live chat sync...' : 'Enable live chat sync'}
                    </button>
                  )
                ) : (
                  <button className="primary-button" onClick={() => {
                    void loadChannelChat(selectedChannel, { forceFull: true });
                  }} disabled={isLoadingChat}>
                    {isLoadingChat ? 'Refreshing chat...' : 'Refresh chat'}
                  </button>
                )}
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

            {sendChatError ? (
              <div className="message-strip error-strip">
                <strong>Send error</strong>
                <p>{sendChatError}</p>
              </div>
            ) : null}

            {!channelChat && isLoadingChat ? (
              <div className="empty-state">
                <p>Loading recent chat messages...</p>
                <span>The app is fetching the initial snapshot through the browser bridge. Once it arrives, the newest Kick messages will stay pinned at the top automatically.</span>
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
                  <p>{tokenOnlyMode ? hasActiveRealtimeTarget ? 'No recent realtime messages were returned yet.' : browserChatEnabled ? 'No recent chat messages were returned yet.' : 'Live chat sync is not connected yet.' : 'No recent chat messages were returned.'}</p>
                  <span>{tokenOnlyMode ? hasActiveRealtimeTarget ? 'Realtime subscriptions are active for this live channel, so the latest messages should appear at the top automatically.' : browserChatEnabled ? 'If the realtime websocket is connected, the latest messages will appear at the top automatically.' : 'Finish the Kick browser sync first. After that, Chatterbro can load chat history and switch into realtime updates.' : 'Kick may have an empty history for this channel right now. If the live websocket is connected, the latest messages will appear at the top automatically.'}</span>
                </div>
              ) : (
                <div className="chat-feed" ref={chatFeedRef}>
                  {displayedChatMessages.map((message) => renderChatMessage(message))}
                </div>
              )
            ) : null}

            <div className="chat-composer-shell">
              <div className="chat-composer-status">
                <span className="chat-composer-status-dot" />
                <span>{tokenOnlyMode ? hasActiveRealtimeTarget ? hasChatWriteScope ? 'Realtime + official send' : 'Realtime + reconnect for chat:write' : browserChatEnabled ? hasChatWriteScope ? 'Live mirror + official send' : 'Live mirror + reconnect for chat:write' : hasChatWriteScope ? 'Official send ready' : 'Reconnect for chat:write' : liveChatState === 'live' ? 'Live mirror' : 'Read-only sync'}</span>
              </div>

              {tokenOnlyMode ? (
                <div className="chat-composer-form">
                  <textarea
                    className="chat-composer-textarea"
                    value={chatDraft}
                    onChange={(event) => {
                      if (!selectedChannelSlug) {
                        return;
                      }

                      setChatDraftForChannel(selectedChannelSlug, event.target.value);
                    }}
                    placeholder={selectedChannel.isLive
                      ? hasChatWriteScope
                        ? `Write to ${selectedChannel.displayName}...`
                        : 'Reconnect Kick once to grant chat:write before sending from Chatterbro.'
                      : 'This tracked channel is offline right now.'}
                    disabled={!selectedChannel.isLive || (!hasChatWriteScope && !canSendSelectedChannelChat) || isSendingChat}
                    maxLength={500}
                  />

                  <div className="chat-composer-button-row">
                    <span className="chat-composer-help">{chatDraft.trim().length}/500</span>

                    {!hasChatWriteScope ? (
                      <button className="primary-button" type="button" onClick={handleReconnectOAuth}>
                        Grant chat:write
                      </button>
                    ) : (
                      <button className="primary-button" type="button" onClick={() => void handleSendChatMessage()} disabled={!canSendSelectedChannelChat || isSendingChat || chatDraft.trim().length === 0}>
                        {isSendingChat ? 'Sending...' : 'Send message'}
                      </button>
                    )}

                    <a className="chat-composer-link" href={selectedChannel.channelUrl} target="_blank" rel="noopener noreferrer">
                      Open Kick chat
                    </a>
                  </div>
                </div>
              ) : (
                <>
                  <div className="chat-composer-input">
                    Message sending stays on Kick. Open the channel to join the chat directly.
                  </div>
                  <a className="chat-composer-link" href={selectedChannel.channelUrl} target="_blank" rel="noopener noreferrer">
                    Open Kick chat
                  </a>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <p>No channel chat selected yet.</p>
            <span>{tokenOnlyMode ? 'After your followings or watchlist load, enable live chat sync once and then open chat on any live channel to render recent messages and keep them updating in realtime.' : 'After loading your live followings, click Open chat on any online channel to render its recent Kick chat here and keep it updating in real time.'}</span>
          </div>
        )}
      </section>
    </main>
  );
}
