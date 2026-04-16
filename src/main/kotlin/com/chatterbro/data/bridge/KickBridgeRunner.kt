package com.chatterbro.data.bridge

import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.FollowedChannel
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
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
    }

    private val loginProcess = AtomicReference<Process?>(null)
    private val serviceProcess = AtomicReference<Process?>(null)
    private val serviceWarmupInProgress = AtomicBoolean(false)
    private val serviceLock = Any()

    @Volatile
    private var serviceReader: BufferedReader? = null

    @Volatile
    private var serviceWriter: BufferedWriter? = null

    private var requestCounter = 0L

    fun startLoginBridge(): KickBridgeStatus {
        paths.ensureDirectories()

        synchronized(serviceLock) {
            stopServiceProcessLocked()
        }

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
        return invokeServiceCommand(
            command = "fetch-live-following",
            payload = emptyMap(),
            deserializer = ListSerializer(FollowedChannel.serializer()),
        )
    }

    fun fetchChannelChat(
        channelSlug: String,
    ): ChannelChat {
        return invokeServiceCommand(
            command = "fetch-channel-chat",
            payload = mapOf("channelSlug" to JsonPrimitive(channelSlug)),
            deserializer = ChannelChat.serializer(),
        )
    }

    fun prewarmService() {
        if (!paths.scriptFile.exists()) {
            return
        }

        if (loginProcess.get()?.isAlive == true) {
            return
        }

        if (!statusStore.hasValidBrowserSession()) {
            return
        }

        val existingProcess = serviceProcess.get()
        if (existingProcess?.isAlive == true && serviceReader != null && serviceWriter != null) {
            return
        }

        if (!serviceWarmupInProgress.compareAndSet(false, true)) {
            return
        }

        thread(isDaemon = true, name = "kick-bridge-service-prewarm") {
            try {
                synchronized(serviceLock) {
                    if (loginProcess.get()?.isAlive == true) {
                        return@synchronized
                    }

                    if (!statusStore.hasValidBrowserSession()) {
                        return@synchronized
                    }

                    ensureServiceProcessLocked()
                }
            } catch (_: IllegalStateException) {
                // Let the bridge lazily recover on demand if background prewarm fails.
            } finally {
                serviceWarmupInProgress.set(false)
            }
        }
    }

    private fun <T> invokeServiceCommand(
        command: String,
        payload: Map<String, JsonElement>,
        deserializer: DeserializationStrategy<T>,
    ): T {
        paths.ensureDirectories()

        if (!paths.scriptFile.exists()) {
            throw IllegalStateException("Bridge script is missing at ${paths.scriptFile}.")
        }

        synchronized(serviceLock) {
            var lastFailure: ServiceBridgeException? = null

            repeat(2) {
                try {
                    ensureServiceProcessLocked()
                    return sendServiceCommandLocked(command, payload, deserializer)
                } catch (exception: ServiceBridgeException) {
                    lastFailure = exception
                    stopServiceProcessLocked()
                } catch (exception: IllegalStateException) {
                    if (!isRecoverableBridgeFailure(exception)) {
                        throw exception
                    }

                    lastFailure = ServiceBridgeException(
                        exception.message ?: "Kick bridge service request failed.",
                        exception,
                    )
                    stopServiceProcessLocked()
                }
            }

            throw IllegalStateException(
                lastFailure?.message ?: "Kick bridge service is unavailable.",
                lastFailure,
            )
        }
    }

    private fun ensureServiceProcessLocked() {
        val existingProcess = serviceProcess.get()
        if (existingProcess?.isAlive == true && serviceReader != null && serviceWriter != null) {
            return
        }

        stopServiceProcessLocked()

        val process = ProcessBuilder(
            "node",
            paths.scriptFile.toString(),
            "serve",
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
            .redirectError(ProcessBuilder.Redirect.appendTo(paths.logFile.toFile()))
            .start()

        val reader = process.inputStream.bufferedReader()
        val writer = process.outputStream.bufferedWriter()

        try {
            val readyLine = reader.readLine()
                ?: throw ServiceBridgeException("Kick bridge service exited before becoming ready.")
            val readyPayload = json.parseToJsonElement(readyLine).jsonObject
            val readyType = readyPayload["type"]?.jsonPrimitive?.contentOrNull
            if (readyType != "ready") {
                throw ServiceBridgeException("Kick bridge service returned an unexpected startup response.")
            }

            serviceProcess.set(process)
            serviceReader = reader
            serviceWriter = writer

            thread(isDaemon = true, name = "kick-bridge-service-watcher") {
                process.waitFor()
                synchronized(serviceLock) {
                    if (serviceProcess.get() === process) {
                        serviceProcess.set(null)
                        serviceReader = null
                        serviceWriter = null
                    }
                }
            }
        } catch (exception: Exception) {
            closeQuietly(writer)
            closeQuietly(reader)
            process.destroyForcibly()
            throw if (exception is ServiceBridgeException) exception else ServiceBridgeException(
                exception.message ?: "Kick bridge service failed to start.",
                exception,
            )
        }
    }

    private fun <T> sendServiceCommandLocked(
        command: String,
        payload: Map<String, JsonElement>,
        deserializer: DeserializationStrategy<T>,
    ): T {
        val reader = serviceReader ?: throw ServiceBridgeException("Kick bridge service reader is unavailable.")
        val writer = serviceWriter ?: throw ServiceBridgeException("Kick bridge service writer is unavailable.")
        val requestId = (++requestCounter).toString()
        val request = buildJsonObject {
            put("id", JsonPrimitive(requestId))
            put("command", JsonPrimitive(command))
            payload.forEach { (key, value) ->
                put(key, value)
            }
        }

        try {
            writer.write(json.encodeToString(JsonObject.serializer(), request))
            writer.newLine()
            writer.flush()
        } catch (exception: IOException) {
            throw ServiceBridgeException("Kick bridge service command could not be written.", exception)
        }

        val responseLine = try {
            reader.readLine()
        } catch (exception: IOException) {
            throw ServiceBridgeException("Kick bridge service closed before responding.", exception)
        } ?: throw ServiceBridgeException("Kick bridge service ended unexpectedly.")

        val response = try {
            json.parseToJsonElement(responseLine).jsonObject
        } catch (exception: Exception) {
            throw ServiceBridgeException("Kick bridge service returned malformed JSON.", exception)
        }

        val responseId = response["id"]?.jsonPrimitive?.contentOrNull
        if (responseId != requestId) {
            throw ServiceBridgeException("Kick bridge service returned an out-of-order response.")
        }

        val ok = response["ok"]?.jsonPrimitive?.booleanOrNull == true
        if (!ok) {
            val errorMessage = response["error"]?.jsonPrimitive?.contentOrNull
                ?: "Kick bridge service request failed."
            throw IllegalStateException(errorMessage)
        }

        val result = response["result"]
            ?: throw ServiceBridgeException("Kick bridge service response is missing a result payload.")
        return json.decodeFromJsonElement(deserializer, result)
    }

    private fun stopServiceProcessLocked() {
        closeQuietly(serviceWriter)
        closeQuietly(serviceReader)
        serviceWriter = null
        serviceReader = null

        val process = serviceProcess.getAndSet(null) ?: return
        if (process.isAlive) {
            process.destroy()
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly()
            }
        }
    }

    private fun closeQuietly(closeable: Closeable?) {
        try {
            closeable?.close()
        } catch (_: IOException) {
            // Ignore bridge cleanup failures.
        }
    }

    private fun isRecoverableBridgeFailure(exception: IllegalStateException): Boolean {
        val message = exception.message ?: return false
        return message.contains("Target page, context or browser has been closed", ignoreCase = true)
    }

    private class ServiceBridgeException(
        message: String,
        cause: Throwable? = null,
    ) : IllegalStateException(message, cause)
}
