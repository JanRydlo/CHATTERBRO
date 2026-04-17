package com.chatterbro.data.bridge

import kotlinx.serialization.json.Json
import kotlin.io.path.createTempDirectory
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KickBridgeRunnerTest {
	private val json = Json

	@Test
	fun `startLoginBridge does not treat saved browser session as active auth`() {
		val rootDirectory = createTempDirectory("kick-bridge-runner-test")
		val paths = KickBridgePaths(rootDirectory)
		val statusStore = KickBridgeStatusStore(paths, oauthEnabled = false)
		val runner = KickBridgeRunner(paths, statusStore)

		val session = KickBridgeSession(
			token = "Bearer test-token",
			expiresAt = "2099-01-01T00:00:00Z",
			profile = KickBridgeProfile(
				username = "tester",
				userId = 1,
				avatarUrl = null,
				channelUrl = "https://kick.com/tester",
			),
		)

		paths.ensureDirectories()
		paths.sessionFile.writeText(json.encodeToString(KickBridgeSession.serializer(), session))

		val status = runner.startLoginBridge()

		assertEquals(BridgeState.ERROR, status.state)
		assertEquals("Bridge script is missing at ${paths.scriptFile}.", status.message)
	}

	@Test
	fun `startLoginBridge forceReconnect bypasses existing browser session guard`() {
		val rootDirectory = createTempDirectory("kick-bridge-runner-force-test")
		val paths = KickBridgePaths(rootDirectory)
		val statusStore = KickBridgeStatusStore(paths, oauthEnabled = false)
		val runner = KickBridgeRunner(paths, statusStore)

		val session = KickBridgeSession(
			token = "Bearer test-token",
			expiresAt = "2099-01-01T00:00:00Z",
			profile = KickBridgeProfile(
				username = "tester",
				userId = 1,
				avatarUrl = null,
				channelUrl = "https://kick.com/tester",
			),
		)

		paths.ensureDirectories()
		paths.sessionFile.writeText(json.encodeToString(KickBridgeSession.serializer(), session))

		val status = runner.startLoginBridge(forceReconnect = true)

		assertEquals(BridgeState.ERROR, status.state)
		assertEquals("Bridge script is missing at ${paths.scriptFile}.", status.message)
	}
}
