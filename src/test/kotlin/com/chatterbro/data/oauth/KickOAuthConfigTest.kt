package com.chatterbro.data.oauth

import kotlin.io.path.createTempDirectory
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class KickOAuthConfigTest {
    @Test
    fun `fromSources reads oauth settings from dot env file`() {
        val tempDirectory = createTempDirectory("kick-oauth-config-test")
        val envFile = tempDirectory.resolve(".env")
        envFile.writeText(
            """
            KICK_CLIENT_ID=test-client-id
            KICK_CLIENT_SECRET=test-client-secret
            KICK_REDIRECT_URI=http://localhost:8080/api/auth/callback
            CHATTERBRO_FRONTEND_URL=http://localhost:5173
            KICK_OAUTH_SCOPES=user:read channel:read
            """.trimIndent(),
        )

        val config = KickOAuthConfig.fromSources(environment = emptyMap(), envFile = envFile)

        assertNotNull(config)
        assertEquals("test-client-id", config.clientId)
        assertEquals("test-client-secret", config.clientSecret)
        assertEquals("http://localhost:8080/api/auth/callback", config.redirectUri)
        assertEquals("http://localhost:5173", config.frontendUrl)
        assertEquals(listOf("user:read", "channel:read"), config.scopes)
    }

    @Test
    fun `fromSources returns null when required oauth settings are missing`() {
        val tempDirectory = createTempDirectory("kick-oauth-config-missing-test")
        val envFile = tempDirectory.resolve(".env")
        envFile.writeText("CHATTERBRO_FRONTEND_URL=http://localhost:5173")

        val config = KickOAuthConfig.fromSources(environment = emptyMap(), envFile = envFile)

        assertNull(config)
    }

    @Test
    fun `fromSources uses chat write in default scopes`() {
        val config = KickOAuthConfig.fromSources(
            environment = mapOf(
                "KICK_CLIENT_ID" to "client-id",
                "KICK_CLIENT_SECRET" to "client-secret",
                "KICK_REDIRECT_URI" to "http://localhost:8080/api/auth/callback",
            ),
            envFile = createTempDirectory("kick-oauth-default-scope-test").resolve("missing.env"),
        )

        assertNotNull(config)
        assertEquals(listOf("user:read", "channel:read", "chat:write"), config.scopes)
    }
}