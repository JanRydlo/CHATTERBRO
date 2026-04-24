package com.chatterbro.data.twitch

import com.chatterbro.data.bridge.BridgeState
import com.chatterbro.data.bridge.KickAuthMode
import com.chatterbro.data.bridge.KickBridgeProfile
import com.chatterbro.data.bridge.KickBridgeStatus
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
import java.time.Instant
import kotlin.io.path.deleteIfExists
import kotlin.io.path.exists
import kotlin.io.path.readText
import kotlin.io.path.writeText

class TwitchOAuthService(
    private val config: TwitchOAuthConfig,
    private val paths: TwitchPaths,
) {
    private val httpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
    }

    init {
        paths.ensureDirectories()
    }

    val clientId: String
        get() = config.clientId

    fun readStatus(): KickBridgeStatus {
        val now = Instant.now()
        val session = readSession()
        val activeSession = session?.takeIf { !it.isExpired(now) }

        return when {
            activeSession != null -> KickBridgeStatus(
                state = BridgeState.READY,
                message = "Connected as ${activeSession.profile.displayName.ifBlank { activeSession.profile.login }} via Twitch OAuth.",
                hasToken = true,
                isAuthenticated = true,
                tokenExpiresAt = activeSession.expiresAt,
                profile = activeSession.profile.toBridgeProfile(),
                oauthEnabled = true,
                hasBrowserSession = false,
                authMode = KickAuthMode.OAUTH,
                grantedScopes = activeSession.grantedScopes(),
            )

            session?.isExpired(now) == true -> KickBridgeStatus(
                state = BridgeState.IDLE,
                message = "Twitch OAuth token expired. Connect again.",
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = true,
                hasBrowserSession = false,
            )

            readPendingAuthorization() != null -> KickBridgeStatus(
                state = BridgeState.RUNNING,
                message = "Opening Twitch OAuth sign-in...",
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = true,
                hasBrowserSession = false,
            )

            else -> configuredDefaultStatus()
        }
    }

    fun beginAuthorization(): String {
        val pendingAuthorization = TwitchOAuthPendingAuthorization(
            state = randomToken(24),
        )
        writePendingAuthorization(pendingAuthorization)

        val query = listOf(
            "response_type" to "code",
            "client_id" to config.clientId,
            "redirect_uri" to config.redirectUri,
            "scope" to config.scopes.joinToString(" "),
            "state" to pendingAuthorization.state,
        ).joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }

        return "https://id.twitch.tv/oauth2/authorize?$query"
    }

    fun handleCallback(code: String, state: String): TwitchOAuthSession {
        val pendingAuthorization = readPendingAuthorization()
            ?: throw IllegalStateException("Twitch OAuth authorization is missing or expired. Start the sign-in flow again.")

        if (pendingAuthorization.state != state) {
            clearPendingAuthorization()
            throw IllegalStateException("Twitch OAuth state mismatch. Start the sign-in flow again.")
        }

        val tokenResponse = exchangeAuthorizationCode(code)
        val profile = fetchAuthenticatedProfile(tokenResponse.accessToken)
        val session = TwitchOAuthSession(
            accessToken = tokenResponse.accessToken,
            refreshToken = tokenResponse.refreshToken,
            tokenType = tokenResponse.tokenType.ifBlank { "bearer" },
            scope = tokenResponse.scope,
            expiresAt = tokenResponse.expiresIn?.let { Instant.now().plusSeconds(it).toString() },
            profile = profile,
        )

        writeSession(session)
        clearPendingAuthorization()
        return session
    }

    fun requireActiveSession(requiredScopes: List<String> = emptyList()): TwitchOAuthSession {
        val session = refreshStoredSessionIfNeeded() ?: readSession()
            ?: throw IllegalStateException("Sign in to Twitch first.")

        if (session.isExpired()) {
            clearSession()
            throw IllegalStateException("Twitch OAuth session expired. Connect again.")
        }

        val missingScopes = requiredScopes.filterNot(session::hasScope)
        if (missingScopes.isNotEmpty()) {
            throw IllegalStateException(
                "Reconnect Twitch with the ${missingScopes.joinToString(", ")} scope${if (missingScopes.size == 1) "" else "s"} before using this feature.",
            )
        }

        return session
    }

    fun refreshStoredSessionIfNeeded(): TwitchOAuthSession? {
        val storedSession = readSession() ?: return null
        if (!storedSession.shouldRefresh()) {
            return storedSession
        }

        return try {
            val refreshedToken = refreshAccessToken(storedSession.refreshToken)
            val profile = fetchAuthenticatedProfile(refreshedToken.accessToken)
            val refreshedSession = TwitchOAuthSession(
                accessToken = refreshedToken.accessToken,
                refreshToken = refreshedToken.refreshToken.ifBlank { storedSession.refreshToken },
                tokenType = refreshedToken.tokenType.ifBlank { storedSession.tokenType },
                scope = refreshedToken.scope.ifEmpty { storedSession.scope },
                expiresAt = refreshedToken.expiresIn?.let { Instant.now().plusSeconds(it).toString() },
                profile = profile,
            )
            writeSession(refreshedSession)
            refreshedSession
        } catch (_: Exception) {
            clearSession()
            null
        }
    }

    fun readSession(): TwitchOAuthSession? {
        return if (paths.oauthSessionFile.exists()) {
            json.decodeFromString<TwitchOAuthSession>(paths.oauthSessionFile.readText())
        } else {
            null
        }
    }

    fun clearSession() {
        paths.oauthSessionFile.deleteIfExists()
        clearPendingAuthorization()
    }

    fun buildFrontendRedirect(success: Boolean, message: String? = null): String {
        val queryParameters = linkedMapOf<String, String>()
        queryParameters["provider"] = "twitch"
        queryParameters["auth"] = if (success) "success" else "error"
        if (!message.isNullOrBlank()) {
            queryParameters["message"] = message
        }

        val query = queryParameters.entries.joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }
        return "${config.frontendUrl}/?$query"
    }

    private fun exchangeAuthorizationCode(code: String): TwitchOAuthTokenResponse {
        return requestToken(
            mapOf(
                "grant_type" to "authorization_code",
                "client_id" to config.clientId,
                "client_secret" to config.clientSecret,
                "redirect_uri" to config.redirectUri,
                "code" to code,
            ),
        )
    }

    private fun refreshAccessToken(refreshToken: String): TwitchOAuthTokenResponse {
        return requestToken(
            mapOf(
                "grant_type" to "refresh_token",
                "client_id" to config.clientId,
                "client_secret" to config.clientSecret,
                "refresh_token" to refreshToken,
            ),
        )
    }

    private fun requestToken(parameters: Map<String, String>): TwitchOAuthTokenResponse {
        val body = parameters.entries.joinToString("&") { (key, value) ->
            "${encode(key)}=${encode(value)}"
        }

        val request = HttpRequest.newBuilder()
            .uri(URI("https://id.twitch.tv/oauth2/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != HttpStatusCode.OK.value) {
            throw IllegalStateException("Twitch OAuth token exchange failed: ${response.body().take(500)}")
        }

        return json.decodeFromString<TwitchOAuthTokenResponse>(response.body())
    }

    private fun fetchAuthenticatedProfile(accessToken: String): TwitchProfile {
        val request = HttpRequest.newBuilder()
            .uri(URI("https://api.twitch.tv/helix/users"))
            .header("Authorization", "Bearer $accessToken")
            .header("Client-ID", config.clientId)
            .header("Accept", "application/json")
            .GET()
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() != HttpStatusCode.OK.value) {
            throw IllegalStateException("Twitch OAuth profile lookup failed: ${response.body().take(500)}")
        }

        val profile = json.decodeFromString<TwitchUserEnvelope>(response.body()).data.firstOrNull()
            ?: throw IllegalStateException("Twitch OAuth profile did not return an authenticated user.")

        return TwitchProfile(
            login = profile.login,
            displayName = profile.displayName.ifBlank { profile.login },
            userId = profile.id.toLongOrNull(),
            avatarUrl = profile.profileImageUrl?.takeIf { it.isNotBlank() },
        )
    }

    private fun writeSession(session: TwitchOAuthSession) {
        paths.ensureDirectories()
        paths.oauthSessionFile.writeText(json.encodeToString(TwitchOAuthSession.serializer(), session))
    }

    private fun readPendingAuthorization(): TwitchOAuthPendingAuthorization? {
        return if (paths.oauthPendingFile.exists()) {
            json.decodeFromString<TwitchOAuthPendingAuthorization>(paths.oauthPendingFile.readText())
        } else {
            null
        }
    }

    private fun writePendingAuthorization(pendingAuthorization: TwitchOAuthPendingAuthorization) {
        paths.ensureDirectories()
        paths.oauthPendingFile.writeText(json.encodeToString(TwitchOAuthPendingAuthorization.serializer(), pendingAuthorization))
    }

    private fun clearPendingAuthorization() {
        paths.oauthPendingFile.deleteIfExists()
    }

    private fun configuredDefaultStatus(): KickBridgeStatus {
        return KickBridgeStatus(
            state = BridgeState.IDLE,
            message = "Twitch OAuth has not been started yet.",
            hasToken = false,
            isAuthenticated = false,
            oauthEnabled = true,
            hasBrowserSession = false,
        )
    }

    private fun randomToken(byteLength: Int): String {
        val bytes = ByteArray(byteLength)
        java.security.SecureRandom().nextBytes(bytes)
        return bytes.joinToString(separator = "") { byte ->
            "%02x".format(byte)
        }
    }

    private fun encode(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8)
    }

    companion object {
        fun unconfiguredStatus(): KickBridgeStatus {
            return KickBridgeStatus(
                state = BridgeState.IDLE,
                message = "Twitch OAuth is not configured. Set TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, and TWITCH_REDIRECT_URI.",
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = false,
                hasBrowserSession = false,
            )
        }
    }
}

private fun TwitchProfile.toBridgeProfile(): KickBridgeProfile {
    return KickBridgeProfile(
        username = login,
        userId = userId,
        avatarUrl = avatarUrl,
        channelUrl = channelUrl,
    )
}

@Serializable
private data class TwitchOAuthTokenResponse(
    @SerialName("access_token")
    val accessToken: String,
    @SerialName("refresh_token")
    val refreshToken: String,
    @SerialName("token_type")
    val tokenType: String = "bearer",
    @SerialName("expires_in")
    val expiresIn: Long? = null,
    val scope: List<String> = emptyList(),
)

@Serializable
private data class TwitchUserEnvelope(
    val data: List<TwitchOAuthUserResponse> = emptyList(),
)

@Serializable
private data class TwitchOAuthUserResponse(
    val id: String,
    val login: String,
    @SerialName("display_name")
    val displayName: String,
    @SerialName("profile_image_url")
    val profileImageUrl: String? = null,
)