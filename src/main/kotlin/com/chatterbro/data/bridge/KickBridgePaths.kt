package com.chatterbro.data.bridge

import java.nio.file.Path
import kotlin.io.path.createDirectories

data class KickBridgePaths(
    val rootDirectory: Path,
) {
    val bridgeDirectory: Path = rootDirectory.resolve("bridge")
    val sessionDirectory: Path = bridgeDirectory.resolve("session")
    val profileDirectory: Path = bridgeDirectory.resolve("browser-profile-cdp")
    val scriptFile: Path = bridgeDirectory.resolve("kick-bridge.mjs")
    val cookiesFile: Path = sessionDirectory.resolve("kick-cookies.json")
    val metadataFile: Path = sessionDirectory.resolve("browser-meta.json")
    val sessionFile: Path = sessionDirectory.resolve("kick-session.json")
    val statusFile: Path = sessionDirectory.resolve("bridge-status.json")
    val outputFile: Path = sessionDirectory.resolve("live-following.json")
    val logFile: Path = sessionDirectory.resolve("bridge.log")

    fun ensureDirectories() {
        bridgeDirectory.createDirectories()
        sessionDirectory.createDirectories()
        profileDirectory.createDirectories()
    }
}
