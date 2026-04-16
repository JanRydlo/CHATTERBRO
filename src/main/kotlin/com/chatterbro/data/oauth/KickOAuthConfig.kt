package com.chatterbro.data.oauth

data class KickOAuthConfig(
    val clientId: String,
    val clientSecret: String,
    val redirectUri: String,
    val frontendUrl: String,
    val scopes: List<String>,
) {
    companion object {
        fun fromEnvironment(): KickOAuthConfig? {
            val clientId = System.getenv("KICK_CLIENT_ID")?.trim().orEmpty()
            val clientSecret = System.getenv("KICK_CLIENT_SECRET")?.trim().orEmpty()
            val redirectUri = System.getenv("KICK_REDIRECT_URI")?.trim().orEmpty()

            if (clientId.isBlank() || clientSecret.isBlank() || redirectUri.isBlank()) {
                return null
            }

            val frontendUrl = System.getenv("CHATTERBRO_FRONTEND_URL")?.trim().orEmpty()
                .ifBlank { "http://localhost:8080" }
                .trimEnd('/')

            val scopes = System.getenv("KICK_OAUTH_SCOPES")
                ?.split(',', ' ')
                ?.map(String::trim)
                ?.filter(String::isNotBlank)
                ?.distinct()
                ?.takeIf(List<String>::isNotEmpty)
                ?: listOf("user:read", "channel:read")

            return KickOAuthConfig(
                clientId = clientId,
                clientSecret = clientSecret,
                redirectUri = redirectUri,
                frontendUrl = frontendUrl,
                scopes = scopes,
            )
        }
    }
}