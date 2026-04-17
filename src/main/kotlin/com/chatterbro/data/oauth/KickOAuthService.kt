package com.chatterbro.data.oauth

import com.chatterbro.data.bridge.BridgeState
import com.chatterbro.data.bridge.KickBridgePaths
import com.chatterbro.data.bridge.KickBridgeProfile
import com.chatterbro.data.bridge.KickBridgeStatus
import com.chatterbro.data.bridge.KickBridgeStatusStore
import com.chatterbro.domain.model.PostedChatMessage
import com.chatterbro.domain.model.FollowedChannel
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Locale
import kotlin.io.path.deleteIfExists
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText

class KickOAuthService(
    private val config: KickOAuthConfig,
    private val paths: KickBridgePaths,
    private val statusStore: KickBridgeStatusStore,
) {
    private val httpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
    }
    private val secureRandom = SecureRandom()

    fun beginAuthorization(): String {
        val pendingAuthorization = KickOAuthPendingAuthorization(
            state = randomToken(24),
            codeVerifier = randomToken(64),
        )
        val existingSession = readSession()?.takeIf { !it.isExpired() }

        writePendingAuthorization(pendingAuthorization)
        statusStore.writeStatus(
            KickBridgeStatus(
                state = BridgeState.RUNNING,
                message = "Opening Kick OAuth sign-in...",
                hasToken = existingSession != null,
                isAuthenticated = existingSession != null,
                tokenExpiresAt = existingSession?.expiresAt,
                profile = existingSession?.profile,
                oauthEnabled = true,
                hasBrowserSession = statusStore.hasValidBrowserSession(),
                grantedScopes = existingSession?.grantedScopes().orEmpty(),
            ),
        )

        val parameters = mutableListOf(
            "response_type" to "code",
            "client_id" to config.clientId,
        )

        if (runCatching { URI(config.redirectUri).host.equals("127.0.0.1", ignoreCase = true) }.getOrDefault(false)) {
            parameters += "redirect" to "127.0.0.1"
        }

        parameters += listOf(
            "redirect_uri" to config.redirectUri,
            "scope" to config.scopes.joinToString(" "),
            "code_challenge" to codeChallengeFor(pendingAuthorization.codeVerifier),
            "code_challenge_method" to "S256",
            "state" to pendingAuthorization.state,
        )

        val query = parameters.joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }
        return "https://id.kick.com/oauth/authorize?$query"
    }

    fun handleCallback(code: String, state: String): KickOAuthSession {
        val pendingAuthorization = readPendingAuthorization()
            ?: throw IllegalStateException("Kick OAuth authorization is missing or expired. Start the sign-in flow again.")

        if (pendingAuthorization.state != state) {
            clearPendingAuthorization()
            throw IllegalStateException("Kick OAuth state mismatch. Start the sign-in flow again.")
        }

        val tokenResponse = exchangeAuthorizationCode(code, pendingAuthorization.codeVerifier)
        val profile = fetchAuthenticatedProfile(tokenResponse.accessToken)
        val session = KickOAuthSession(
            accessToken = tokenResponse.accessToken,
            refreshToken = tokenResponse.refreshToken,
            tokenType = tokenResponse.tokenType.ifBlank { "Bearer" },
            scope = tokenResponse.scope,
            expiresAt = tokenResponse.expiresIn?.let { Instant.now().plusSeconds(it).toString() },
            profile = profile,
        )

        writeSession(session)
        clearPendingAuthorization()
        statusStore.writeStatus(
            KickBridgeStatus(
                state = BridgeState.READY,
                message = "Connected as ${profile.username} via Kick OAuth.",
                hasToken = true,
                isAuthenticated = true,
                tokenExpiresAt = session.expiresAt,
                profile = session.profile,
                oauthEnabled = true,
                hasBrowserSession = statusStore.hasValidBrowserSession(),
                grantedScopes = session.grantedScopes(),
            ),
        )
        return session
    }

    fun refreshStoredSessionIfNeeded(): KickOAuthSession? {
        val storedSession = readSession() ?: return null
        if (!storedSession.shouldRefresh()) {
            return storedSession
        }

        return try {
            val refreshedToken = refreshAccessToken(storedSession.refreshToken)
            val profile = fetchAuthenticatedProfile(refreshedToken.accessToken)
            val refreshedSession = KickOAuthSession(
                accessToken = refreshedToken.accessToken,
                refreshToken = refreshedToken.refreshToken.ifBlank { storedSession.refreshToken },
                tokenType = refreshedToken.tokenType.ifBlank { storedSession.tokenType },
                scope = refreshedToken.scope ?: storedSession.scope,
                expiresAt = refreshedToken.expiresIn?.let { Instant.now().plusSeconds(it).toString() },
                profile = profile,
            )
            writeSession(refreshedSession)
            refreshedSession
        } catch (_: Exception) {
            clearSession()
            statusStore.writeStatus(
                KickBridgeStatus(
                    state = BridgeState.IDLE,
                    message = "Kick OAuth session expired. Connect again.",
                    hasToken = false,
                    isAuthenticated = false,
                    oauthEnabled = true,
                    hasBrowserSession = statusStore.hasValidBrowserSession(),
                ),
            )
            null
        }
    }

    fun readSession(): KickOAuthSession? {
        return if (paths.oauthSessionFile.exists()) {
            json.decodeFromString<KickOAuthSession>(paths.oauthSessionFile.readText())
        } else {
            null
        }
    }

    fun clearSession() {
        paths.oauthSessionFile.deleteIfExists()
    }

    fun fetchLiveChannelsBySlugs(rawSlugs: List<String>): List<FollowedChannel> {
        return fetchTrackedChannelsBySlugs(rawSlugs)
            .filter(FollowedChannel::isLive)
    }

    fun fetchTrackedChannelsBySlugs(rawSlugs: List<String>): List<FollowedChannel> {
        val session = requireActiveSession()
        val slugs = normalizeChannelSlugs(rawSlugs)
        if (slugs.isEmpty()) {
            return emptyList()
        }

        val channelsResponse = requestAuthorizedJson(
            url = buildChannelsLookupUrl(slugs),
            accessToken = session.accessToken,
        )
        val channels = json.decodeFromString<KickListResponse<KickTrackedChannelResponse>>(channelsResponse).data
        val liveBroadcasterUserIds = channels.mapNotNull { channel ->
            channel.broadcasterUserId?.takeIf { channel.stream?.isLive == true }
        }
            .distinct()
        val livestreamsByBroadcasterUserId = if (liveBroadcasterUserIds.isEmpty()) {
            emptyMap()
        } else {
            json.decodeFromString<KickListResponse<KickLivestreamResponse>>(
                requestAuthorizedJson(
                    url = buildLivestreamsLookupUrl(liveBroadcasterUserIds),
                    accessToken = session.accessToken,
                ),
            )
                .data
                .mapNotNull { livestream ->
                    livestream.broadcasterUserId?.let { broadcasterUserId ->
                        broadcasterUserId to livestream
                    }
                }
                .toMap()
        }
        val channelsBySlug = channels
            .mapNotNull { channel ->
                val channelSlug = channel.slug?.trim()?.lowercase(Locale.ROOT).orEmpty()
                if (channelSlug.isBlank()) {
                    null
                } else {
                    channelSlug to channel
                }
            }
            .toMap()

        return slugs.map { requestedSlug ->
            val resolvedChannel = channelsBySlug[requestedSlug]
                ?: return@map FollowedChannel(
                    channelSlug = requestedSlug,
                    displayName = requestedSlug,
                    isLive = false,
                    channelUrl = "https://kick.com/$requestedSlug",
                    chatUrl = "https://kick.com/$requestedSlug",
                )

            val channelSlug = resolvedChannel.slug?.trim().orEmpty().ifBlank { requestedSlug }
            val broadcasterUserId = resolvedChannel.broadcasterUserId
            val livestream = broadcasterUserId?.let(livestreamsByBroadcasterUserId::get)
            val displayName = resolvedChannel.user?.username?.trim().orEmpty()
                .ifBlank { resolvedChannel.user?.name?.trim().orEmpty() }
                .ifBlank { channelSlug }
            val categoryName = livestream?.category?.name?.trim().orEmpty()
                .ifBlank { resolvedChannel.category?.name?.trim().orEmpty() }
                .ifBlank { null }
            val tags = (livestream?.customTags ?: resolvedChannel.stream?.customTags.orEmpty())
                .map(String::trim)
                .filter(String::isNotBlank)

            FollowedChannel(
                channelSlug = channelSlug,
                displayName = displayName,
                isLive = resolvedChannel.stream?.isLive == true,
                channelUrl = "https://kick.com/$channelSlug",
                chatUrl = "https://kick.com/$channelSlug",
                thumbnailUrl = livestream?.profilePicture?.takeIf { it.isNotBlank() }
                    ?: resolvedChannel.user?.profilePicture?.takeIf { it.isNotBlank() }
                    ?: resolvedChannel.profilePicture?.takeIf { it.isNotBlank() }
                    ?: livestream?.thumbnail?.takeIf { it.isNotBlank() }
                    ?: resolvedChannel.stream?.thumbnail?.takeIf { it.isNotBlank() },
                broadcasterUserId = broadcasterUserId,
                channelId = livestream?.channelId,
                viewerCount = livestream?.viewerCount ?: resolvedChannel.stream?.viewerCount,
                streamTitle = livestream?.streamTitle?.takeIf { it.isNotBlank() }
                    ?: resolvedChannel.streamTitle?.takeIf { it.isNotBlank() },
                categoryName = categoryName,
                tags = tags,
            )
        }
    }

    fun sendChatMessage(
        channelSlug: String,
        broadcasterUserId: Long?,
        content: String,
        replyToMessageId: String? = null,
    ): PostedChatMessage {
        val session = requireActiveSession()
        ensureScope(session, requiredScope = "chat:write")

        val normalizedContent = content.trim()
        if (normalizedContent.isBlank()) {
            throw IllegalStateException("Enter a chat message before sending it.")
        }

        val resolvedBroadcasterUserId = broadcasterUserId
            ?: fetchTrackedChannelsBySlugs(listOf(channelSlug)).firstOrNull()?.broadcasterUserId
            ?: throw IllegalStateException("Kick did not expose a broadcaster user id for $channelSlug.")

        val responseBody = requestAuthorizedJson(
            url = "https://api.kick.com/public/v1/chat",
            accessToken = session.accessToken,
            method = "POST",
            requestBody = json.encodeToString(
                KickPostChatRequest(
                    broadcasterUserId = resolvedBroadcasterUserId,
                    content = normalizedContent,
                    replyToMessageId = replyToMessageId?.trim()?.ifBlank { null },
                ),
            ),
        )
        val response = json.decodeFromString<KickResponse<KickChatResponse>>(responseBody)
        val data = response.data
            ?: throw IllegalStateException("Kick did not return a chat message response.")

        if (!data.isSent || data.messageId.isBlank()) {
            throw IllegalStateException("Kick did not confirm that the chat message was sent.")
        }

        return PostedChatMessage(
            isSent = true,
            messageId = data.messageId,
        )
    }

    fun buildFrontendRedirect(success: Boolean, message: String? = null): String {
        val queryParameters = linkedMapOf<String, String>()
        queryParameters["auth"] = if (success) "success" else "error"
        if (!message.isNullOrBlank()) {
            queryParameters["message"] = message
        }

        val query = queryParameters.entries.joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }
        return "${config.frontendUrl}/?$query"
    }

    private fun exchangeAuthorizationCode(code: String, codeVerifier: String): KickOAuthTokenResponse {
        return requestToken(
            mapOf(
                "grant_type" to "authorization_code",
                "client_id" to config.clientId,
                "client_secret" to config.clientSecret,
                "redirect_uri" to config.redirectUri,
                "code_verifier" to codeVerifier,
                "code" to code,
            ),
        )
    }

    private fun refreshAccessToken(refreshToken: String): KickOAuthTokenResponse {
        return requestToken(
            mapOf(
                "grant_type" to "refresh_token",
                "client_id" to config.clientId,
                "client_secret" to config.clientSecret,
                "refresh_token" to refreshToken,
            ),
        )
    }

    private fun requestToken(parameters: Map<String, String>): KickOAuthTokenResponse {
        val body = parameters.entries.joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }

        val request = HttpRequest.newBuilder()
            .uri(URI("https://id.kick.com/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != HttpStatusCode.OK.value) {
            throw IllegalStateException("Kick OAuth token exchange failed: ${response.body().take(500)}")
        }

        return json.decodeFromString<KickOAuthTokenResponse>(response.body())
    }

    private fun fetchAuthenticatedProfile(accessToken: String): KickBridgeProfile {
        val userResponse = requestAuthorizedJson(
            url = "https://api.kick.com/public/v1/users",
            accessToken = accessToken,
        )
        val channelResponse = requestAuthorizedJson(
            url = "https://api.kick.com/public/v1/channels",
            accessToken = accessToken,
        )

        val users = json.decodeFromString<KickListResponse<KickUserResponse>>(userResponse)
        val channels = json.decodeFromString<KickListResponse<KickChannelResponse>>(channelResponse)

        val user = users.data.firstOrNull()
        val channel = channels.data.firstOrNull()
        val username = channel?.slug?.ifBlank { null }
            ?: user?.name?.ifBlank { null }
            ?: throw IllegalStateException("Kick OAuth profile did not include a channel slug.")

        return KickBridgeProfile(
            username = username,
            userId = channel?.broadcasterUserId ?: user?.userId,
            avatarUrl = user?.profilePicture,
            channelUrl = "https://kick.com/$username",
        )
    }

    private fun requestAuthorizedJson(
        url: String,
        accessToken: String,
        method: String = "GET",
        requestBody: String? = null,
    ): String {
        val requestBuilder = HttpRequest.newBuilder()
            .uri(URI(url))
            .header("Authorization", "Bearer $accessToken")
            .header("Accept", "application/json")
        if (requestBody != null) {
            requestBuilder.header("Content-Type", "application/json")
        }

        val request = when (method.uppercase(Locale.ROOT)) {
            "GET" -> requestBuilder.GET().build()
            "POST" -> requestBuilder.POST(
                requestBody?.let(HttpRequest.BodyPublishers::ofString)
                    ?: HttpRequest.BodyPublishers.noBody(),
            ).build()
            else -> throw IllegalArgumentException("Unsupported Kick API method: $method")
        }

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != HttpStatusCode.OK.value) {
            if (response.statusCode() == HttpStatusCode.Forbidden.value && url == "https://api.kick.com/public/v1/chat") {
                throw IllegalStateException("Kick denied chat sending. Reconnect Kick with the chat:write scope and try again.")
            }

            throw IllegalStateException("Kick API request failed: ${response.body().take(500)}")
        }

        return response.body()
    }

    private fun buildChannelsLookupUrl(slugs: List<String>): String {
        val query = slugs.joinToString("&") { slug ->
            "slug=${encode(slug)}"
        }
        return "https://api.kick.com/public/v1/channels?$query"
    }

    private fun buildLivestreamsLookupUrl(broadcasterUserIds: List<Long>): String {
        val query = broadcasterUserIds.joinToString("&") { broadcasterUserId ->
            "broadcaster_user_id=${encode(broadcasterUserId.toString())}"
        }
        return "https://api.kick.com/public/v1/livestreams?$query"
    }

    private fun normalizeChannelSlugs(rawSlugs: List<String>): List<String> {
        return rawSlugs
            .map(String::trim)
            .filter(String::isNotBlank)
            .map { it.lowercase(Locale.ROOT) }
            .distinct()
    }

    private fun requireActiveSession(): KickOAuthSession {
        return refreshStoredSessionIfNeeded()
            ?: readSession()?.takeIf { !it.isExpired() }
            ?: throw IllegalStateException("Connect Kick first so the app can use your saved token.")
    }

    private fun ensureScope(session: KickOAuthSession, requiredScope: String) {
        if (session.hasScope(requiredScope)) {
            return
        }

        throw IllegalStateException(
            "Reconnect Kick with the $requiredScope scope. If you override KICK_OAUTH_SCOPES, add $requiredScope there first.",
        )
    }

    private fun readPendingAuthorization(): KickOAuthPendingAuthorization? {
        return if (paths.oauthPendingFile.exists()) {
            json.decodeFromString<KickOAuthPendingAuthorization>(paths.oauthPendingFile.readText())
        } else {
            null
        }
    }

    private fun writePendingAuthorization(pendingAuthorization: KickOAuthPendingAuthorization) {
        paths.oauthPendingFile.writeText(json.encodeToString(pendingAuthorization))
    }

    private fun clearPendingAuthorization() {
        paths.oauthPendingFile.deleteIfExists()
    }

    private fun writeSession(session: KickOAuthSession) {
        paths.oauthSessionFile.writeText(json.encodeToString(session))
    }

    private fun codeChallengeFor(codeVerifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(codeVerifier.toByteArray(StandardCharsets.UTF_8))
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(hash)
    }

    private fun randomToken(byteLength: Int): String {
        val buffer = ByteArray(byteLength)
        secureRandom.nextBytes(buffer)
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(buffer)
    }

    private fun encode(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
    }
}

@Serializable
private data class KickOAuthTokenResponse(
    @SerialName("access_token")
    val accessToken: String,
    @SerialName("refresh_token")
    val refreshToken: String,
    @SerialName("token_type")
    val tokenType: String = "Bearer",
    @SerialName("expires_in")
    val expiresIn: Long? = null,
    val scope: String? = null,
)

@Serializable
private data class KickListResponse<T>(
    val data: List<T> = emptyList(),
)

@Serializable
private data class KickResponse<T>(
    val data: T? = null,
)

@Serializable
private data class KickUserResponse(
    @SerialName("user_id")
    val userId: Long? = null,
    @SerialName("profile_picture")
    val profilePicture: String? = null,
    val name: String? = null,
)

@Serializable
private data class KickChannelResponse(
    val slug: String? = null,
    @SerialName("broadcaster_user_id")
    val broadcasterUserId: Long? = null,
)

@Serializable
private data class KickTrackedChannelResponse(
    val slug: String? = null,
    @SerialName("broadcaster_user_id")
    val broadcasterUserId: Long? = null,
    @SerialName("profile_picture")
    val profilePicture: String? = null,
    val category: KickTrackedCategoryResponse? = null,
    val user: KickTrackedChannelUser? = null,
    val stream: KickTrackedChannelStream? = null,
    @SerialName("stream_title")
    val streamTitle: String? = null,
)

@Serializable
private data class KickTrackedChannelUser(
    val username: String? = null,
    val name: String? = null,
    @SerialName("profile_picture")
    val profilePicture: String? = null,
)

@Serializable
private data class KickTrackedCategoryResponse(
    val name: String? = null,
)

@Serializable
private data class KickTrackedChannelStream(
    @SerialName("is_live")
    val isLive: Boolean? = null,
    val thumbnail: String? = null,
    @SerialName("viewer_count")
    val viewerCount: Int? = null,
    @SerialName("custom_tags")
    val customTags: List<String> = emptyList(),
)

@Serializable
private data class KickLivestreamResponse(
    @SerialName("broadcaster_user_id")
    val broadcasterUserId: Long? = null,
    @SerialName("channel_id")
    val channelId: Long? = null,
    @SerialName("stream_title")
    val streamTitle: String? = null,
    @SerialName("viewer_count")
    val viewerCount: Int? = null,
    val thumbnail: String? = null,
    @SerialName("profile_picture")
    val profilePicture: String? = null,
    @SerialName("custom_tags")
    val customTags: List<String> = emptyList(),
    val category: KickTrackedCategoryResponse? = null,
)

@Serializable
private data class KickPostChatRequest(
    @SerialName("broadcaster_user_id")
    val broadcasterUserId: Long,
    val content: String,
    @SerialName("reply_to_message_id")
    val replyToMessageId: String? = null,
    val type: String = "user",
)

@Serializable
private data class KickChatResponse(
    @SerialName("is_sent")
    val isSent: Boolean = false,
    @SerialName("message_id")
    val messageId: String = "",
)