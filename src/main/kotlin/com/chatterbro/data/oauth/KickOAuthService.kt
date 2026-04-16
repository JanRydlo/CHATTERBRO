package com.chatterbro.data.oauth

import com.chatterbro.data.bridge.BridgeState
import com.chatterbro.data.bridge.KickBridgePaths
import com.chatterbro.data.bridge.KickBridgeProfile
import com.chatterbro.data.bridge.KickBridgeStatus
import com.chatterbro.data.bridge.KickBridgeStatusStore
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
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
        writePendingAuthorization(pendingAuthorization)

        statusStore.writeStatus(
            KickBridgeStatus(
                state = BridgeState.RUNNING,
                message = "Opening Kick OAuth sign-in...",
                hasToken = readSession()?.let { !it.isExpired() } == true,
                isAuthenticated = readSession()?.let { !it.isExpired() } == true,
                tokenExpiresAt = readSession()?.expiresAt,
                profile = readSession()?.profile,
                oauthEnabled = true,
                hasBrowserSession = statusStore.hasValidBrowserSession(),
            ),
        )

        val parameters = linkedMapOf(
            "response_type" to "code",
            "client_id" to config.clientId,
            "redirect_uri" to config.redirectUri,
            "scope" to config.scopes.joinToString(" "),
            "code_challenge" to codeChallengeFor(pendingAuthorization.codeVerifier),
            "code_challenge_method" to "S256",
            "state" to pendingAuthorization.state,
        )

        if (runCatching { URI(config.redirectUri).host.equals("127.0.0.1", ignoreCase = true) }.getOrDefault(false)) {
            parameters["redirect"] = "127.0.0.1"
        }

        val query = parameters.entries.joinToString("&") { (key, value) ->
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

    private fun requestAuthorizedJson(url: String, accessToken: String): String {
        val request = HttpRequest.newBuilder()
            .uri(URI(url))
            .header("Authorization", "Bearer $accessToken")
            .header("Accept", "application/json")
            .GET()
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != HttpStatusCode.OK.value) {
            throw IllegalStateException("Kick API request failed: ${response.body().take(500)}")
        }

        return response.body()
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