package com.chatterbro.data.bridge

import kotlinx.serialization.json.Json
import kotlin.io.path.createTempDirectory
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

class KickBridgeStatusStoreTest {
    private val json = Json

    @Test
    fun `readStatus resets stale oauth running state when no token is stored`() {
        val rootDirectory = createTempDirectory("kick-bridge-status-store-test")
        val paths = KickBridgePaths(rootDirectory)
        val statusStore = KickBridgeStatusStore(paths, oauthEnabled = true)

        statusStore.writeStatus(
            KickBridgeStatus(
                state = BridgeState.RUNNING,
                message = "Opening Kick OAuth sign-in...",
                hasToken = false,
                isAuthenticated = false,
                oauthEnabled = true,
                hasBrowserSession = false,
            ),
        )

        val status = statusStore.readStatus()

        assertEquals(BridgeState.IDLE, status.state)
        assertEquals("Kick OAuth has not been started yet.", status.message)

        val persistedStatus = json.decodeFromString<KickBridgeStatus>(paths.statusFile.readText())
        assertEquals(BridgeState.IDLE, persistedStatus.state)
        assertEquals("Kick OAuth has not been started yet.", persistedStatus.message)
    }
}