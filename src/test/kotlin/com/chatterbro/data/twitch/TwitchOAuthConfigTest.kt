package com.chatterbro.data.twitch

import kotlin.io.path.createTempDirectory
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class TwitchOAuthConfigTest {
    @Test
    fun `fromSources reads twitch oauth settings from dot env file`() {
        val tempDirectory = createTempDirectory("twitch-oauth-config-test")
        val envFile = tempDirectory.resolve(".env")
        envFile.writeText(
            """
            TWITCH_CLIENT_ID=test-client-id
            TWITCH_CLIENT_SECRET=test-client-secret
            TWITCH_REDIRECT_URI=http://localhost:8080/api/twitch/auth/callback
            CHATTERBRO_FRONTEND_URL=http://localhost:5173
            TWITCH_OAUTH_SCOPES=user:read:follows chat:read chat:edit
            """.trimIndent(),
        )

        val config = TwitchOAuthConfig.fromSources(environment = emptyMap(), envFile = envFile)

        assertNotNull(config)
        assertEquals("test-client-id", config.clientId)
        assertEquals("test-client-secret", config.clientSecret)
        assertEquals("http://localhost:8080/api/twitch/auth/callback", config.redirectUri)
        assertEquals("http://localhost:5173", config.frontendUrl)
        assertEquals(listOf("user:read:follows", "chat:read", "chat:edit"), config.scopes)
    }

    @Test
    fun `fromSources returns null when required twitch oauth settings are missing`() {
        val tempDirectory = createTempDirectory("twitch-oauth-config-missing-test")
        val envFile = tempDirectory.resolve(".env")
        envFile.writeText("CHATTERBRO_FRONTEND_URL=http://localhost:5173")

        val config = TwitchOAuthConfig.fromSources(environment = emptyMap(), envFile = envFile)

        assertNull(config)
    }

    @Test
    fun `fromSources uses chat scopes in default twitch scopes`() {
        val config = TwitchOAuthConfig.fromSources(
            environment = mapOf(
                "TWITCH_CLIENT_ID" to "client-id",
                "TWITCH_CLIENT_SECRET" to "client-secret",
                "TWITCH_REDIRECT_URI" to "http://localhost:8080/api/twitch/auth/callback",
            ),
            envFile = createTempDirectory("twitch-oauth-default-scope-test").resolve("missing.env"),
        )

        assertNotNull(config)
        assertEquals(listOf("user:read:follows", "chat:read", "chat:edit", "user:read:emotes"), config.scopes)
    }
}