package com.chatterbro.data.twitch

import com.chatterbro.config.LocalEnvironment
import java.nio.file.Path
import java.nio.file.Paths

data class TwitchOAuthConfig(
    val clientId: String,
    val clientSecret: String,
    val redirectUri: String,
    val frontendUrl: String,
    val scopes: List<String>,
) {
    companion object {
        private val defaultScopes = listOf(
            "user:read:follows",
            "chat:read",
            "chat:edit",
            "user:read:emotes",
        )

        fun fromEnvironment(): TwitchOAuthConfig? {
            return fromSources()
        }

        internal fun fromSources(
            environment: Map<String, String> = System.getenv(),
            envFile: Path = Paths.get(".env"),
        ): TwitchOAuthConfig? {
            val clientId = LocalEnvironment.read("TWITCH_CLIENT_ID", environment, envFile).orEmpty()
            val clientSecret = LocalEnvironment.read("TWITCH_CLIENT_SECRET", environment, envFile).orEmpty()
            val redirectUri = LocalEnvironment.read("TWITCH_REDIRECT_URI", environment, envFile).orEmpty()

            if (clientId.isBlank() || clientSecret.isBlank() || redirectUri.isBlank()) {
                return null
            }

            val frontendUrl = LocalEnvironment.read("CHATTERBRO_FRONTEND_URL", environment, envFile).orEmpty()
                .ifBlank { "http://localhost:8080" }
                .trimEnd('/')

            val scopes = LocalEnvironment.read("TWITCH_OAUTH_SCOPES", environment, envFile)
                ?.split(',', ' ')
                ?.map(String::trim)
                ?.filter(String::isNotBlank)
                ?.distinct()
                ?.takeIf(List<String>::isNotEmpty)
                ?: defaultScopes

            return TwitchOAuthConfig(
                clientId = clientId,
                clientSecret = clientSecret,
                redirectUri = redirectUri,
                frontendUrl = frontendUrl,
                scopes = scopes,
            )
        }
    }
}