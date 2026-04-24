package com.chatterbro.data.oauth

import com.chatterbro.data.bridge.KickBridgePaths
import com.chatterbro.data.bridge.KickBridgeStatusStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.io.path.createTempDirectory
import kotlin.io.path.deleteRecursively
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import java.net.URI

class KickOAuthServiceTest {
    private val json = Json

    @Test
    fun `beginAuthorization places redirect workaround before redirect uri for 127 host`() {
        val service = createService("http://127.0.0.1:8080/api/auth/callback")

        val authorizeUrl = service.beginAuthorization()
        val queryParts = URI(authorizeUrl).rawQuery.split("&")

        val redirectIndex = queryParts.indexOfFirst { it.startsWith("redirect=") }
        val redirectUriIndex = queryParts.indexOfFirst { it.startsWith("redirect_uri=") }

        assertTrue(redirectIndex >= 0, "Expected the 127.0.0.1 workaround parameter to be present.")
        assertTrue(redirectUriIndex >= 0, "Expected redirect_uri to be present in the authorization URL.")
        assertTrue(redirectIndex < redirectUriIndex, "The workaround parameter must appear before redirect_uri.")
        assertEquals("redirect=127.0.0.1", queryParts[redirectIndex])
    }

    @Test
    fun `beginAuthorization omits redirect workaround for localhost redirect uri`() {
        val service = createService("http://localhost:8080/api/auth/callback")

        val authorizeUrl = service.beginAuthorization()
        val queryParts = URI(authorizeUrl).rawQuery.split("&")

        assertEquals(-1, queryParts.indexOfFirst { it.startsWith("redirect=") })
        assertTrue(queryParts.any { it.startsWith("redirect_uri=") })
    }

    @Test
    fun `buildPostChatRequestBody omits null reply field`() {
        val service = createService("http://localhost:8080/api/auth/callback")

        val payload = json.parseToJsonElement(
            service.buildPostChatRequestBody(
                broadcasterUserId = 123L,
                content = "Pog",
                replyToMessageId = null,
            ),
        ).jsonObject

        assertEquals(JsonPrimitive(123L), payload["broadcaster_user_id"])
        assertEquals(JsonPrimitive("Pog"), payload["content"])
        assertEquals(JsonPrimitive("user"), payload["type"])
        assertFalse(payload.containsKey("reply_to_message_id"))
    }

    private fun createService(redirectUri: String): KickOAuthService {
        val rootDirectory = createTempDirectory("kick-oauth-service-test")
        val paths = KickBridgePaths(rootDirectory)
        val statusStore = KickBridgeStatusStore(paths, oauthEnabled = true)
        val config = KickOAuthConfig(
            clientId = "client-id",
            clientSecret = "client-secret",
            redirectUri = redirectUri,
            frontendUrl = "http://localhost:5173",
            scopes = listOf("user:read", "channel:read"),
        )

        return KickOAuthService(config, paths, statusStore).also {
            rootDirectory.toFile().deleteOnExit()
            paths.bridgeDirectory.toFile().deleteOnExit()
            paths.sessionDirectory.toFile().deleteOnExit()
            paths.profileDirectory.toFile().deleteOnExit()
        }
    }
}