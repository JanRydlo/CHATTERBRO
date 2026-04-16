package com.chatterbro.data.bridge

import com.chatterbro.domain.model.FollowedChannel
import kotlinx.serialization.json.Json
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.io.path.exists
import kotlin.io.path.readText

class KickBridgeRunner(
    private val paths: KickBridgePaths,
    private val statusStore: KickBridgeStatusStore,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
    }

    private val loginProcess = AtomicReference<Process?>(null)

    fun startLoginBridge(): KickBridgeStatus {
        paths.ensureDirectories()

        val currentProcess = loginProcess.get()
        if (currentProcess?.isAlive == true) {
            return statusStore.readStatus().copy(message = "Kick bridge login window is already running.")
        }

        if (!paths.scriptFile.exists()) {
            val failureStatus = KickBridgeStatus(
                state = BridgeState.ERROR,
                message = "Bridge script is missing at ${paths.scriptFile}.",
                hasToken = statusStore.readStatus().hasToken,
                isAuthenticated = statusStore.readStatus().isAuthenticated,
            )
            statusStore.writeStatus(failureStatus)
            return failureStatus
        }

        statusStore.writeStatus(
            KickBridgeStatus(
                state = BridgeState.RUNNING,
                message = "Opening Kick login browser...",
                hasToken = false,
                isAuthenticated = false,
            ),
        )

        val process = ProcessBuilder(
            "node",
            paths.scriptFile.toString(),
            "login",
            "--status-file",
            paths.statusFile.toString(),
            "--cookie-file",
            paths.cookiesFile.toString(),
            "--session-file",
            paths.sessionFile.toString(),
            "--profile-dir",
            paths.profileDirectory.toString(),
            "--meta-file",
            paths.metadataFile.toString(),
        )
            .directory(paths.rootDirectory.toFile())
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.appendTo(paths.logFile.toFile()))
            .start()

        loginProcess.set(process)
        thread(isDaemon = true, name = "kick-bridge-login-watcher") {
            process.waitFor()
            loginProcess.compareAndSet(process, null)
        }

        return statusStore.readStatus()
    }

    fun fetchLiveFollowedChannels(): List<FollowedChannel> {
        paths.ensureDirectories()

        if (!paths.scriptFile.exists()) {
            throw IllegalStateException("Bridge script is missing at ${paths.scriptFile}.")
        }

        val process = ProcessBuilder(
            "node",
            paths.scriptFile.toString(),
            "fetch-live-following",
            "--status-file",
            paths.statusFile.toString(),
            "--cookie-file",
            paths.cookiesFile.toString(),
            "--session-file",
            paths.sessionFile.toString(),
            "--profile-dir",
            paths.profileDirectory.toString(),
            "--meta-file",
            paths.metadataFile.toString(),
            "--output-file",
            paths.outputFile.toString(),
        )
            .directory(paths.rootDirectory.toFile())
            .redirectErrorStream(true)
            .start()

        val output = process.inputStream.bufferedReader().readText().trim()
        val completed = process.waitFor(90, TimeUnit.SECONDS)

        if (!completed) {
            process.destroyForcibly()
            throw IllegalStateException("Kick bridge timed out while loading live followings.")
        }

        if (process.exitValue() != 0) {
            val message = output.ifBlank {
                "Kick bridge failed with exit code ${process.exitValue()}."
            }
            throw IllegalStateException(message)
        }

        if (!paths.outputFile.exists()) {
            throw IllegalStateException("Kick bridge did not produce a following output file.")
        }

        return json.decodeFromString(paths.outputFile.readText())
    }
}
