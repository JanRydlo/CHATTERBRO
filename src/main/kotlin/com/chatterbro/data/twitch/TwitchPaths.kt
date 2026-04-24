package com.chatterbro.data.twitch

import java.nio.file.Path
import kotlin.io.path.createDirectories

data class TwitchPaths(
    val rootDirectory: Path,
) {
    val bridgeDirectory: Path = rootDirectory.resolve("bridge")
    val sessionDirectory: Path = bridgeDirectory.resolve("session")
    val oauthSessionFile: Path = sessionDirectory.resolve("twitch-oauth-session.json")
    val oauthPendingFile: Path = sessionDirectory.resolve("twitch-oauth-pending.json")

    fun ensureDirectories() {
        bridgeDirectory.createDirectories()
        sessionDirectory.createDirectories()
    }
}