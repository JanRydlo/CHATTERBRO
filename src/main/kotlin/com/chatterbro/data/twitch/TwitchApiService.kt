package com.chatterbro.data.twitch

import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatBadge
import com.chatterbro.domain.model.ChannelChatEmote
import com.chatterbro.domain.model.ChannelChatEmoteCatalog
import com.chatterbro.domain.model.ChannelChatMessage
import com.chatterbro.domain.model.ChannelChatRequest
import com.chatterbro.domain.model.FollowedChannel
import com.chatterbro.domain.model.PostedChatMessage
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

class TwitchApiService(
    private val oauthService: TwitchOAuthService,
    private val chatClient: TwitchChatClient = TwitchChatClient(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    @Volatile
    private var globalEmoteCache: CachedValue<List<ChannelChatEmote>>? = null

    @Volatile
    private var globalBadgeCache: CachedValue<Map<String, List<TwitchBadgeVersionResponse>>>? = null

    private val channelEmoteCache = ConcurrentHashMap<Long, CachedValue<List<ChannelChatEmote>>>()
    private val userEmoteCache = ConcurrentHashMap<String, CachedValue<List<ChannelChatEmote>>>()
    private val channelBadgeCache = ConcurrentHashMap<Long, CachedValue<Map<String, List<TwitchBadgeVersionResponse>>>>()
    private val cacheTtl = Duration.ofMinutes(30)

    fun fetchLiveFollowedChannels(): List<FollowedChannel> {
        val session = oauthService.requireActiveSession(listOf("user:read:follows"))
        val userId = session.profile.userId
            ?: throw IllegalStateException("Twitch OAuth profile did not expose a user id.")

        val followedChannels = fetchFollowedChannels(userId, session.accessToken)
        if (followedChannels.isEmpty()) {
            return emptyList()
        }

        val followedBroadcasterIds = followedChannels.map(TwitchFollowedChannelResponse::broadcasterId)
        val liveStreamsByUserId = fetchStreamsByUserIds(followedBroadcasterIds, session.accessToken)
        if (liveStreamsByUserId.isEmpty()) {
            return emptyList()
        }

        val liveBroadcasterIds = liveStreamsByUserId.keys.toList()
        val usersById = fetchUsersByIds(liveBroadcasterIds, session.accessToken)
        val channelsById = fetchChannelsByBroadcasterIds(liveBroadcasterIds, session.accessToken)

        return followedChannels.mapNotNull { followedChannel ->
            val stream = liveStreamsByUserId[followedChannel.broadcasterId] ?: return@mapNotNull null
            val user = usersById[followedChannel.broadcasterId]
            val channel = channelsById[followedChannel.broadcasterId]
            val broadcasterUserId = followedChannel.broadcasterId.toLongOrNull()

            FollowedChannel(
                provider = "twitch",
                channelSlug = followedChannel.broadcasterLogin.trim().lowercase(Locale.ROOT),
                displayName = followedChannel.broadcasterName.ifBlank { followedChannel.broadcasterLogin },
                isLive = true,
                channelUrl = buildChannelUrl(followedChannel.broadcasterLogin),
                chatUrl = buildChannelUrl(followedChannel.broadcasterLogin),
                thumbnailUrl = user?.profileImageUrl?.takeIf { it.isNotBlank() }
                    ?: stream.thumbnailUrl?.let(::expandThumbnailUrl),
                broadcasterUserId = broadcasterUserId,
                channelId = broadcasterUserId,
                chatroomId = null,
                viewerCount = stream.viewerCount,
                streamTitle = stream.title.takeIf { it.isNotBlank() } ?: channel?.title?.takeIf { it.isNotBlank() },
                categoryName = stream.gameName.takeIf { it.isNotBlank() } ?: channel?.gameName?.takeIf { it.isNotBlank() },
                tags = stream.tags.ifEmpty { channel?.tags.orEmpty() },
                subscriberBadgeImageUrlsByMonths = emptyMap(),
            )
        }
    }

    fun fetchTrackedChannelsBySlugs(rawSlugs: List<String>, liveOnly: Boolean = false): List<FollowedChannel> {
        val session = oauthService.requireActiveSession()
        val slugs = normalizeChannelSlugs(rawSlugs)
        if (slugs.isEmpty()) {
            return emptyList()
        }

        val usersByLogin = fetchUsersByLogins(slugs, session.accessToken)
        val userIds = usersByLogin.values.map(TwitchUserResponse::id)
        val channelsById = fetchChannelsByBroadcasterIds(userIds, session.accessToken)
        val streamsByUserId = fetchStreamsByUserIds(userIds, session.accessToken)

        return slugs.mapNotNull { channelSlug ->
            val user = usersByLogin[channelSlug]
                ?: return@mapNotNull buildMissingTrackedChannel(channelSlug).takeUnless { liveOnly }
            val userId = user.id.toLongOrNull()
            val stream = streamsByUserId[user.id]
            val channel = channelsById[user.id]
            val followedChannel = FollowedChannel(
                provider = "twitch",
                channelSlug = user.login.trim().lowercase(Locale.ROOT),
                displayName = user.displayName.ifBlank { user.login },
                isLive = stream != null,
                channelUrl = buildChannelUrl(user.login),
                chatUrl = buildChannelUrl(user.login),
                thumbnailUrl = user.profileImageUrl?.takeIf { it.isNotBlank() }
                    ?: stream?.thumbnailUrl?.let(::expandThumbnailUrl),
                broadcasterUserId = userId,
                channelId = userId,
                chatroomId = null,
                viewerCount = stream?.viewerCount,
                streamTitle = stream?.title?.takeIf { it.isNotBlank() } ?: channel?.title?.takeIf { it.isNotBlank() },
                categoryName = stream?.gameName?.takeIf { it.isNotBlank() } ?: channel?.gameName?.takeIf { it.isNotBlank() },
                tags = stream?.tags ?: channel?.tags.orEmpty(),
                subscriberBadgeImageUrlsByMonths = emptyMap(),
            )

            if (liveOnly && !followedChannel.isLive) {
                null
            } else {
                followedChannel
            }
        }
    }

    fun getGlobalEmotes(): ChannelChatEmoteCatalog {
        val session = oauthService.requireActiveSession()
        return ChannelChatEmoteCatalog(
            channelSlug = "twitch-global",
            channelUserId = null,
            emotes = loadGlobalEmotes(session.accessToken),
            updatedAt = Instant.now().toString(),
        )
    }

    fun getChannelEmotes(channelSlug: String, channelUserId: Long?): ChannelChatEmoteCatalog {
        val session = oauthService.requireActiveSession()
        val resolvedChannel = resolveChannel(
            channelSlug = channelSlug,
            channelUserId = channelUserId,
            displayName = null,
            avatarUrl = null,
            accessToken = session.accessToken,
        )

        val emotes = mergeEmotes(
            loadGlobalEmotes(session.accessToken),
            loadChannelEmotes(resolvedChannel.userId, session.accessToken),
            loadUserEmotes(session, resolvedChannel.userId),
        )

        return ChannelChatEmoteCatalog(
            channelSlug = resolvedChannel.login,
            channelUserId = resolvedChannel.userId,
            emotes = emotes,
            updatedAt = Instant.now().toString(),
        )
    }

    fun loadChannelChat(request: ChannelChatRequest): ChannelChat {
        val session = oauthService.requireActiveSession(listOf("chat:read"))
        val resolvedChannel = resolveChannel(
            channelSlug = request.channelSlug,
            channelUserId = request.channelUserId ?: request.channelId,
            displayName = request.displayName,
            avatarUrl = request.avatarUrl,
            accessToken = session.accessToken,
        )

        chatClient.ensureJoined(session, resolvedChannel.login)
        val badgeCatalog = loadBadgeCatalog(resolvedChannel.userId, session.accessToken)
        val messages = enrichMessagesWithBadgeImages(chatClient.getMessages(resolvedChannel.login), badgeCatalog)

        return ChannelChat(
            provider = "twitch",
            channelSlug = resolvedChannel.login,
            channelId = resolvedChannel.userId,
            channelUserId = resolvedChannel.userId,
            chatroomId = null,
            displayName = resolvedChannel.displayName,
            channelUrl = resolvedChannel.channelUrl,
            avatarUrl = resolvedChannel.avatarUrl,
            cursor = null,
            messages = messages,
            pinnedMessage = null,
            subscriberBadgeImageUrlsByMonths = badgeCatalog.subscriberBadgeImageUrlsByMonths,
            updatedAt = Instant.now().toString(),
        )
    }

    fun sendChatMessage(
        channelSlug: String,
        broadcasterUserId: Long?,
        content: String,
        replyToMessageId: String? = null,
    ): PostedChatMessage {
        val session = oauthService.requireActiveSession(listOf("chat:edit"))
        val resolvedChannel = resolveChannel(
            channelSlug = channelSlug,
            channelUserId = broadcasterUserId,
            displayName = null,
            avatarUrl = null,
            accessToken = session.accessToken,
        )

        val normalizedContent = content.trim()
        if (normalizedContent.isBlank()) {
            throw IllegalStateException("Enter a chat message before sending it.")
        }

        chatClient.ensureJoined(session, resolvedChannel.login)
        return PostedChatMessage(
            isSent = true,
            messageId = chatClient.sendMessage(
                session = session,
                channelSlug = resolvedChannel.login,
                content = normalizedContent,
                replyToMessageId = replyToMessageId,
            ),
        )
    }

    private fun resolveChannel(
        channelSlug: String,
        channelUserId: Long?,
        displayName: String?,
        avatarUrl: String?,
        accessToken: String,
    ): ResolvedTwitchChannel {
        val user = when {
            channelUserId != null -> fetchUsersByIds(listOf(channelUserId.toString()), accessToken).values.firstOrNull()
            else -> fetchUsersByLogins(listOf(channelSlug), accessToken)[channelSlug.trim().lowercase(Locale.ROOT)]
        } ?: throw IllegalStateException("Twitch did not expose channel metadata for ${channelSlug.trim().ifBlank { "this channel" }}.")

        val userId = user.id.toLongOrNull()
            ?: throw IllegalStateException("Twitch did not expose a numeric user id for ${user.login}.")
        val stream = fetchStreamsByUserIds(listOf(user.id), accessToken)[user.id]
        val channel = fetchChannelsByBroadcasterIds(listOf(user.id), accessToken)[user.id]

        return ResolvedTwitchChannel(
            login = user.login.trim().lowercase(Locale.ROOT),
            displayName = displayName?.takeIf(String::isNotBlank) ?: user.displayName.ifBlank { user.login },
            userId = userId,
            avatarUrl = avatarUrl?.takeIf(String::isNotBlank) ?: user.profileImageUrl?.takeIf { it.isNotBlank() },
            channelUrl = buildChannelUrl(user.login),
            isLive = stream != null,
            streamTitle = stream?.title?.takeIf { it.isNotBlank() } ?: channel?.title?.takeIf { it.isNotBlank() },
            categoryName = stream?.gameName?.takeIf { it.isNotBlank() } ?: channel?.gameName?.takeIf { it.isNotBlank() },
            tags = stream?.tags ?: channel?.tags.orEmpty(),
        )
    }

    private fun fetchFollowedChannels(userId: Long, accessToken: String): List<TwitchFollowedChannelResponse> {
        val followedChannels = mutableListOf<TwitchFollowedChannelResponse>()
        var cursor: String? = null

        repeat(20) {
            val queryParameters = mutableListOf(
                "user_id" to userId.toString(),
                "first" to "100",
            )
            cursor?.let { queryParameters += "after" to it }

            val response = json.decodeFromString<TwitchListResponse<TwitchFollowedChannelResponse>>(
                requestHelixJson(
                    path = "/channels/followed",
                    queryParameters = queryParameters,
                    accessToken = accessToken,
                ),
            )
            followedChannels += response.data
            cursor = response.pagination?.cursor?.takeIf(String::isNotBlank)
            if (cursor == null) {
                return followedChannels
            }
        }

        return followedChannels
    }

    private fun fetchUsersByLogins(logins: List<String>, accessToken: String): Map<String, TwitchUserResponse> {
        val normalizedLogins = normalizeChannelSlugs(logins)
        if (normalizedLogins.isEmpty()) {
            return emptyMap()
        }

        return normalizedLogins.chunked(100)
            .flatMap { loginChunk ->
                json.decodeFromString<TwitchListResponse<TwitchUserResponse>>(
                    requestHelixJson(
                        path = "/users",
                        queryParameters = loginChunk.map { login -> "login" to login },
                        accessToken = accessToken,
                    ),
                ).data
            }
            .associateBy { user -> user.login.trim().lowercase(Locale.ROOT) }
    }

    private fun fetchUsersByIds(userIds: List<String>, accessToken: String): Map<String, TwitchUserResponse> {
        val normalizedUserIds = userIds.map(String::trim).filter(String::isNotBlank).distinct()
        if (normalizedUserIds.isEmpty()) {
            return emptyMap()
        }

        return normalizedUserIds.chunked(100)
            .flatMap { userIdChunk ->
                json.decodeFromString<TwitchListResponse<TwitchUserResponse>>(
                    requestHelixJson(
                        path = "/users",
                        queryParameters = userIdChunk.map { userId -> "id" to userId },
                        accessToken = accessToken,
                    ),
                ).data
            }
            .associateBy(TwitchUserResponse::id)
    }

    private fun fetchStreamsByUserIds(userIds: List<String>, accessToken: String): Map<String, TwitchStreamResponse> {
        val normalizedUserIds = userIds.map(String::trim).filter(String::isNotBlank).distinct()
        if (normalizedUserIds.isEmpty()) {
            return emptyMap()
        }

        return normalizedUserIds.chunked(100)
            .flatMap { userIdChunk ->
                json.decodeFromString<TwitchListResponse<TwitchStreamResponse>>(
                    requestHelixJson(
                        path = "/streams",
                        queryParameters = userIdChunk.map { userId -> "user_id" to userId },
                        accessToken = accessToken,
                    ),
                ).data
            }
            .associateBy(TwitchStreamResponse::userId)
    }

    private fun fetchChannelsByBroadcasterIds(userIds: List<String>, accessToken: String): Map<String, TwitchChannelInformationResponse> {
        val normalizedUserIds = userIds.map(String::trim).filter(String::isNotBlank).distinct()
        if (normalizedUserIds.isEmpty()) {
            return emptyMap()
        }

        return normalizedUserIds.chunked(100)
            .flatMap { userIdChunk ->
                json.decodeFromString<TwitchListResponse<TwitchChannelInformationResponse>>(
                    requestHelixJson(
                        path = "/channels",
                        queryParameters = userIdChunk.map { userId -> "broadcaster_id" to userId },
                        accessToken = accessToken,
                    ),
                ).data
            }
            .associateBy(TwitchChannelInformationResponse::broadcasterId)
    }

    private fun loadGlobalEmotes(accessToken: String): List<ChannelChatEmote> {
        val cached = globalEmoteCache
        val now = Instant.now()
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.value
        }

        val globalEmotes = fetchGlobalEmotes(accessToken)
        globalEmoteCache = CachedValue(globalEmotes, now.plus(cacheTtl))
        return globalEmotes
    }

    private fun loadChannelEmotes(channelUserId: Long, accessToken: String): List<ChannelChatEmote> {
        val cached = channelEmoteCache[channelUserId]
        val now = Instant.now()
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.value
        }

        val emotes = fetchChannelEmotes(channelUserId, accessToken)
        channelEmoteCache[channelUserId] = CachedValue(emotes, now.plus(cacheTtl))
        return emotes
    }

    private fun loadUserEmotes(session: TwitchOAuthSession, broadcasterUserId: Long): List<ChannelChatEmote> {
        val userId = session.profile.userId ?: return emptyList()
        if (!session.hasScope("user:read:emotes")) {
            return emptyList()
        }

        val cacheKey = "$userId:$broadcasterUserId"
        val cached = userEmoteCache[cacheKey]
        val now = Instant.now()
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.value
        }

        val emotes = runCatching {
            fetchUserEmotes(
                userId = userId,
                broadcasterUserId = broadcasterUserId,
                accessToken = session.accessToken,
            )
        }.getOrDefault(emptyList())

        userEmoteCache[cacheKey] = CachedValue(emotes, now.plus(cacheTtl))
        return emotes
    }

    private fun fetchGlobalEmotes(accessToken: String): List<ChannelChatEmote> {
        val response = json.decodeFromString<TwitchEmoteEnvelope>(
            requestHelixJson(
                path = "/chat/emotes/global",
                queryParameters = emptyList(),
                accessToken = accessToken,
            ),
        )
        return response.data.mapNotNull { emote ->
            emote.toChannelChatEmote(response.template)
        }
    }

    private fun fetchChannelEmotes(channelUserId: Long, accessToken: String): List<ChannelChatEmote> {
        val response = json.decodeFromString<TwitchEmoteEnvelope>(
            requestHelixJson(
                path = "/chat/emotes",
                queryParameters = listOf("broadcaster_id" to channelUserId.toString()),
                accessToken = accessToken,
            ),
        )
        return response.data.mapNotNull { emote ->
            emote.toChannelChatEmote(response.template)
        }
    }

    private fun fetchUserEmotes(userId: Long, broadcasterUserId: Long, accessToken: String): List<ChannelChatEmote> {
        val response = json.decodeFromString<TwitchEmoteEnvelope>(
            requestHelixJson(
                path = "/chat/emotes/user",
                queryParameters = listOf(
                    "user_id" to userId.toString(),
                    "broadcaster_id" to broadcasterUserId.toString(),
                ),
                accessToken = accessToken,
            ),
        )
        return response.data.mapNotNull { emote ->
            emote.toChannelChatEmote(response.template)
        }
    }

    private fun loadBadgeCatalog(channelUserId: Long, accessToken: String): TwitchBadgeCatalog {
        return TwitchBadgeCatalog(
            globalBadges = loadGlobalBadges(accessToken),
            channelBadges = loadChannelBadges(channelUserId, accessToken),
        )
    }

    private fun loadGlobalBadges(accessToken: String): Map<String, List<TwitchBadgeVersionResponse>> {
        val cached = globalBadgeCache
        val now = Instant.now()
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.value
        }

        val badges = fetchGlobalBadges(accessToken)
        globalBadgeCache = CachedValue(badges, now.plus(cacheTtl))
        return badges
    }

    private fun loadChannelBadges(channelUserId: Long, accessToken: String): Map<String, List<TwitchBadgeVersionResponse>> {
        val cached = channelBadgeCache[channelUserId]
        val now = Instant.now()
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.value
        }

        val badges = fetchChannelBadges(channelUserId, accessToken)
        channelBadgeCache[channelUserId] = CachedValue(badges, now.plus(cacheTtl))
        return badges
    }

    private fun fetchGlobalBadges(accessToken: String): Map<String, List<TwitchBadgeVersionResponse>> {
        return json.decodeFromString<TwitchListResponse<TwitchBadgeSetResponse>>(
            requestHelixJson(
                path = "/chat/badges/global",
                queryParameters = emptyList(),
                accessToken = accessToken,
            ),
        ).data.associate { badgeSet ->
            badgeSet.setId.lowercase(Locale.ROOT) to badgeSet.versions
        }
    }

    private fun fetchChannelBadges(channelUserId: Long, accessToken: String): Map<String, List<TwitchBadgeVersionResponse>> {
        return json.decodeFromString<TwitchListResponse<TwitchBadgeSetResponse>>(
            requestHelixJson(
                path = "/chat/badges",
                queryParameters = listOf("broadcaster_id" to channelUserId.toString()),
                accessToken = accessToken,
            ),
        ).data.associate { badgeSet ->
            badgeSet.setId.lowercase(Locale.ROOT) to badgeSet.versions
        }
    }

    private fun enrichMessagesWithBadgeImages(
        messages: List<ChannelChatMessage>,
        badgeCatalog: TwitchBadgeCatalog,
    ): List<ChannelChatMessage> {
        var changed = false
        val nextMessages = messages.map { message ->
            val nextBadges = message.sender.badges.map { badge ->
                if (!badge.imageUrl.isNullOrBlank()) {
                    return@map badge
                }

                val imageUrl = badgeCatalog.resolveImageUrl(badge) ?: return@map badge
                changed = true
                badge.copy(imageUrl = imageUrl)
            }

            if (nextBadges == message.sender.badges) {
                message
            } else {
                message.copy(sender = message.sender.copy(badges = nextBadges))
            }
        }

        return if (changed) {
            nextMessages
        } else {
            messages
        }
    }

    private fun requestHelixJson(
        path: String,
        queryParameters: List<Pair<String, String>>,
        accessToken: String,
    ): String {
        val request = HttpRequest.newBuilder(buildUri("https://api.twitch.tv/helix$path", queryParameters))
            .header("Authorization", "Bearer $accessToken")
            .header("Client-ID", oauthService.clientId)
            .header("Accept", "application/json")
            .header("User-Agent", "Chatterbro/0.1")
            .timeout(Duration.ofSeconds(10))
            .GET()
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        return when (response.statusCode()) {
            in 200..299 -> response.body()
            401 -> throw IllegalStateException("Sign in to Twitch again. The saved Twitch token is no longer accepted.")
            403 -> throw IllegalStateException("Reconnect Twitch with the required scope before using this feature.")
            else -> throw IllegalStateException("Twitch API request failed: ${response.body().take(500)}")
        }
    }

    private fun buildUri(baseUrl: String, queryParameters: List<Pair<String, String>>): URI {
        if (queryParameters.isEmpty()) {
            return URI(baseUrl)
        }

        val query = queryParameters.joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }
        return URI("$baseUrl?$query")
    }

    private fun encode(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
    }

    private fun normalizeChannelSlugs(rawSlugs: List<String>): List<String> {
        return rawSlugs
            .flatMap { value -> value.split(',') }
            .map { value -> value.trim().removePrefix("@").lowercase(Locale.ROOT) }
            .filter(String::isNotBlank)
            .distinct()
    }

    private fun buildChannelUrl(channelSlug: String): String {
        return "https://www.twitch.tv/${channelSlug.trim().removePrefix("@").lowercase(Locale.ROOT)}"
    }

    private fun expandThumbnailUrl(template: String): String {
        return template
            .replace("{width}", "640")
            .replace("{height}", "360")
    }

    private fun mergeEmotes(vararg emoteSets: List<ChannelChatEmote>): List<ChannelChatEmote> {
        val merged = LinkedHashMap<String, ChannelChatEmote>()
        for (emoteSet in emoteSets) {
            for (emote in emoteSet) {
                merged[emote.code] = emote
            }
        }
        return merged.values.toList()
    }

    private fun buildMissingTrackedChannel(channelSlug: String): FollowedChannel {
        return FollowedChannel(
            provider = "twitch",
            channelSlug = channelSlug,
            displayName = channelSlug,
            isLive = false,
            channelUrl = buildChannelUrl(channelSlug),
            chatUrl = buildChannelUrl(channelSlug),
        )
    }

    private data class CachedValue<T>(
        val value: T,
        val expiresAt: Instant,
    )

    private data class ResolvedTwitchChannel(
        val login: String,
        val displayName: String,
        val userId: Long,
        val avatarUrl: String?,
        val channelUrl: String,
        val isLive: Boolean,
        val streamTitle: String?,
        val categoryName: String?,
        val tags: List<String>,
    )

    private data class TwitchBadgeCatalog(
        val globalBadges: Map<String, List<TwitchBadgeVersionResponse>>,
        val channelBadges: Map<String, List<TwitchBadgeVersionResponse>>,
    ) {
        val subscriberBadgeImageUrlsByMonths: Map<Int, String>
            get() = channelBadges["subscriber"]
                .orEmpty()
                .mapNotNull { version ->
                    version.id.toIntOrNull()?.let { months ->
                        version.bestImageUrl()?.let { imageUrl ->
                            months to imageUrl
                        }
                    }
                }
                .toMap()

        fun resolveImageUrl(badge: ChannelChatBadge): String? {
            val versions = channelBadges[badge.type.lowercase(Locale.ROOT)]
                ?: globalBadges[badge.type.lowercase(Locale.ROOT)]
                ?: return null

            if (versions.isEmpty()) {
                return null
            }

            val exactSubscriberVersion = badge.count?.let { count ->
                versions
                    .mapNotNull { version -> version.id.toIntOrNull()?.let { months -> months to version } }
                    .filter { (months, _) -> months <= count }
                    .maxByOrNull { (months, _) -> months }
                    ?.second
                    ?.bestImageUrl()
            }

            return exactSubscriberVersion ?: versions.firstNotNullOfOrNull(TwitchBadgeVersionResponse::bestImageUrl)
        }
    }
}

private fun TwitchEmoteResponse.toChannelChatEmote(template: String?): ChannelChatEmote? {
    val imageUrl = images.url4x?.takeIf { it.isNotBlank() }
        ?: images.url2x?.takeIf { it.isNotBlank() }
        ?: images.url1x?.takeIf { it.isNotBlank() }
        ?: template
            ?.replace("{{id}}", id)
            ?.replace("{{format}}", if (format.contains("animated")) "animated" else "static")
            ?.replace("{{theme_mode}}", if (themeMode.contains("dark")) "dark" else themeMode.firstOrNull().orEmpty().ifBlank { "dark" })
            ?.replace("{{scale}}", when {
                scale.contains("3.0") -> "3.0"
                scale.contains("2.0") -> "2.0"
                else -> scale.firstOrNull().orEmpty().ifBlank { "2.0" }
            })
        ?: return null

    return ChannelChatEmote(
        code = name,
        imageUrl = imageUrl,
        provider = "Twitch",
        animated = format.contains("animated"),
        width = null,
        height = null,
    )
}

private fun TwitchBadgeVersionResponse.bestImageUrl(): String? {
    return imageUrl4x?.takeIf { it.isNotBlank() }
        ?: imageUrl2x?.takeIf { it.isNotBlank() }
        ?: imageUrl1x?.takeIf { it.isNotBlank() }
}

@Serializable
private data class TwitchListResponse<T>(
    val data: List<T> = emptyList(),
    val pagination: TwitchPagination? = null,
)

@Serializable
private data class TwitchPagination(
    val cursor: String? = null,
)

@Serializable
private data class TwitchFollowedChannelResponse(
    @SerialName("broadcaster_id")
    val broadcasterId: String,
    @SerialName("broadcaster_login")
    val broadcasterLogin: String,
    @SerialName("broadcaster_name")
    val broadcasterName: String,
)

@Serializable
private data class TwitchUserResponse(
    val id: String,
    val login: String,
    @SerialName("display_name")
    val displayName: String,
    @SerialName("profile_image_url")
    val profileImageUrl: String? = null,
)

@Serializable
private data class TwitchStreamResponse(
    val id: String,
    @SerialName("user_id")
    val userId: String,
    @SerialName("user_login")
    val userLogin: String,
    @SerialName("user_name")
    val userName: String,
    @SerialName("game_name")
    val gameName: String = "",
    val title: String = "",
    val tags: List<String> = emptyList(),
    @SerialName("viewer_count")
    val viewerCount: Int? = null,
    @SerialName("thumbnail_url")
    val thumbnailUrl: String? = null,
)

@Serializable
private data class TwitchChannelInformationResponse(
    @SerialName("broadcaster_id")
    val broadcasterId: String,
    @SerialName("game_name")
    val gameName: String = "",
    val title: String = "",
    val tags: List<String> = emptyList(),
)

@Serializable
private data class TwitchEmoteEnvelope(
    val data: List<TwitchEmoteResponse> = emptyList(),
    val template: String? = null,
)

@Serializable
private data class TwitchEmoteResponse(
    val id: String,
    val name: String,
    val images: TwitchEmoteImages = TwitchEmoteImages(),
    val format: List<String> = emptyList(),
    val scale: List<String> = emptyList(),
    @SerialName("theme_mode")
    val themeMode: List<String> = emptyList(),
)

@Serializable
private data class TwitchEmoteImages(
    @SerialName("url_1x")
    val url1x: String? = null,
    @SerialName("url_2x")
    val url2x: String? = null,
    @SerialName("url_4x")
    val url4x: String? = null,
)

@Serializable
private data class TwitchBadgeSetResponse(
    @SerialName("set_id")
    val setId: String,
    val versions: List<TwitchBadgeVersionResponse> = emptyList(),
)

@Serializable
private data class TwitchBadgeVersionResponse(
    val id: String,
    @SerialName("image_url_1x")
    val imageUrl1x: String? = null,
    @SerialName("image_url_2x")
    val imageUrl2x: String? = null,
    @SerialName("image_url_4x")
    val imageUrl4x: String? = null,
)