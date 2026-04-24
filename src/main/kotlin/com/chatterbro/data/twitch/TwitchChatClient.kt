package com.chatterbro.data.twitch

import com.chatterbro.domain.model.ChannelChatBadge
import com.chatterbro.domain.model.ChannelChatMessage
import com.chatterbro.domain.model.ChannelChatSender
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.time.Duration
import java.time.Instant
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentHashMap

class TwitchChatClient {
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    private val connectionLock = Any()
    private val channelBuffers = ConcurrentHashMap<String, ArrayDeque<ChannelChatMessage>>()

    @Volatile
    private var connectionState: ConnectionState? = null

    fun ensureJoined(session: TwitchOAuthSession, channelSlug: String) {
        val normalizedChannelSlug = normalizeChannelSlug(channelSlug)
        val connection = ensureConnection(session)
        if (connection.joinedChannels.add(normalizedChannelSlug)) {
            sendCommand(connection, "JOIN #$normalizedChannelSlug")
        }
    }

    fun sendMessage(
        session: TwitchOAuthSession,
        channelSlug: String,
        content: String,
        replyToMessageId: String? = null,
    ): String {
        val connection = ensureConnection(session)
        val normalizedChannelSlug = normalizeChannelSlug(channelSlug)
        if (connection.joinedChannels.add(normalizedChannelSlug)) {
            sendCommand(connection, "JOIN #$normalizedChannelSlug")
        }

        sendCommand(connection, buildPrivmsgCommand(normalizedChannelSlug, content, replyToMessageId))
        return "twitch-local-${UUID.randomUUID()}"
    }

    fun getMessages(channelSlug: String): List<ChannelChatMessage> {
        val normalizedChannelSlug = normalizeChannelSlug(channelSlug)
        return synchronized(channelBuffers) {
            channelBuffers[normalizedChannelSlug]?.toList().orEmpty()
        }
    }

    internal fun buildPrivmsgCommand(
        channelSlug: String,
        content: String,
        replyToMessageId: String? = null,
    ): String {
        val normalizedChannelSlug = normalizeChannelSlug(channelSlug)
        val normalizedContent = content.trim()
        require(normalizedContent.isNotBlank()) { "Enter a chat message before sending it." }

        val replyPrefix = replyToMessageId
            ?.trim()
            ?.takeIf(String::isNotBlank)
            ?.let { "@reply-parent-msg-id=$it " }
            .orEmpty()

        return "${replyPrefix}PRIVMSG #$normalizedChannelSlug :$normalizedContent"
    }

    private fun ensureConnection(session: TwitchOAuthSession): ConnectionState {
        val normalizedLogin = session.profile.login.trim().lowercase(Locale.ROOT)
        synchronized(connectionLock) {
            val existing = connectionState
            if (existing != null && existing.login == normalizedLogin && existing.accessToken == session.accessToken) {
                return existing
            }

            existing?.close()

            val listener = TwitchIrcListener()
            val webSocket = httpClient.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .buildAsync(URI("wss://irc-ws.chat.twitch.tv:443"), listener)
                .join()
            val connection = ConnectionState(
                accessToken = session.accessToken,
                login = normalizedLogin,
                webSocket = webSocket,
                joinedChannels = ConcurrentHashMap.newKeySet(),
            )
            listener.connection = connection

            sendCommand(connection, "CAP REQ :twitch.tv/commands twitch.tv/tags")
            sendCommand(connection, "PASS oauth:${session.accessToken}")
            sendCommand(connection, "NICK ${connection.login}")

            connectionState = connection
            return connection
        }
    }

    private fun sendCommand(connection: ConnectionState, command: String) {
        try {
            connection.webSocket.sendText(command, true).join()
        } catch (_: Exception) {
            synchronized(connectionLock) {
                if (connectionState === connection) {
                    connectionState = null
                }
            }
            throw IllegalStateException("Twitch chat connection is unavailable. Retry the action.")
        }
    }

    private fun normalizeChannelSlug(channelSlug: String): String {
        return channelSlug.trim().removePrefix("#").lowercase(Locale.ROOT)
    }

    private fun pushMessage(channelSlug: String, message: ChannelChatMessage) {
        synchronized(channelBuffers) {
            val buffer = channelBuffers.getOrPut(channelSlug) { ArrayDeque() }
            if (buffer.any { it.id == message.id }) {
                return
            }

            buffer.addLast(message)
            while (buffer.size > 200) {
                buffer.removeFirst()
            }
        }
    }

    private fun parsePrivmsg(line: String): ParsedPrivmsg? {
        var remaining = line
        val tags = mutableMapOf<String, String>()
        if (remaining.startsWith("@")) {
            val tagsEnd = remaining.indexOf(' ')
            if (tagsEnd <= 1) {
                return null
            }
            tags.putAll(parseTags(remaining.substring(1, tagsEnd)))
            remaining = remaining.substring(tagsEnd + 1)
        }

        var prefix: String? = null
        if (remaining.startsWith(":")) {
            val prefixEnd = remaining.indexOf(' ')
            if (prefixEnd <= 1) {
                return null
            }
            prefix = remaining.substring(1, prefixEnd)
            remaining = remaining.substring(prefixEnd + 1)
        }

        val commandEnd = remaining.indexOf(' ')
        if (commandEnd <= 0) {
            return null
        }

        val command = remaining.substring(0, commandEnd)
        if (command != "PRIVMSG") {
            return null
        }

        remaining = remaining.substring(commandEnd + 1)
        val contentSeparator = remaining.indexOf(" :")
        if (contentSeparator <= 0) {
            return null
        }

        val target = remaining.substring(0, contentSeparator).trim()
        val content = remaining.substring(contentSeparator + 2)
        val channelSlug = target.removePrefix("#").trim().lowercase(Locale.ROOT)
        if (channelSlug.isBlank()) {
            return null
        }

        val login = prefix?.substringBefore('!')?.trim().orEmpty()
        val displayName = tags["display-name"].orEmpty().ifBlank { login }
        if (displayName.isBlank()) {
            return null
        }

        val badges = parseBadges(tags["badges"], tags["badge-info"])
        val userId = tags["user-id"]?.toLongOrNull()
        val messageId = tags["id"].orEmpty().ifBlank {
            "${channelSlug}-${tags["tmi-sent-ts"].orEmpty()}-${login.ifBlank { displayName.lowercase(Locale.ROOT) }}"
        }
        val createdAt = tags["tmi-sent-ts"]?.toLongOrNull()?.let { Instant.ofEpochMilli(it).toString() }

        return ParsedPrivmsg(
            channelSlug = channelSlug,
            message = ChannelChatMessage(
                id = messageId,
                content = content,
                type = "message",
                createdAt = createdAt,
                threadParentId = tags["reply-parent-msg-id"]?.takeIf(String::isNotBlank),
                sender = ChannelChatSender(
                    id = userId,
                    username = displayName,
                    slug = login.ifBlank { displayName.lowercase(Locale.ROOT) },
                    color = tags["color"]?.takeIf(String::isNotBlank),
                    badges = badges,
                ),
            ),
        )
    }

    private fun parseTags(serializedTags: String): Map<String, String> {
        return serializedTags.split(';')
            .mapNotNull { entry ->
                val separatorIndex = entry.indexOf('=')
                if (separatorIndex < 0) {
                    return@mapNotNull null
                }

                val key = entry.substring(0, separatorIndex)
                val value = decodeTagValue(entry.substring(separatorIndex + 1))
                key to value
            }
            .toMap()
    }

    private fun decodeTagValue(value: String): String {
        return value
            .replace("\\s", " ")
            .replace("\\:", ";")
            .replace("\\r", "\r")
            .replace("\\n", "\n")
            .replace("\\\\", "\\")
    }

    private fun parseBadges(serializedBadges: String?, serializedBadgeInfo: String?): List<ChannelChatBadge> {
        if (serializedBadges.isNullOrBlank()) {
            return emptyList()
        }

        val badgeInfo = serializedBadgeInfo
            ?.split(',')
            ?.mapNotNull { entry ->
                val setId = entry.substringBefore('/').trim().lowercase(Locale.ROOT)
                val versionId = entry.substringAfter('/', "").trim()
                if (setId.isBlank() || versionId.isBlank()) {
                    null
                } else {
                    setId to versionId
                }
            }
            ?.toMap()
            .orEmpty()

        return serializedBadges.split(',').mapNotNull { entry ->
            val setId = entry.substringBefore('/').trim().lowercase(Locale.ROOT)
            if (setId.isBlank()) {
                return@mapNotNull null
            }

            val versionId = entry.substringAfter('/', "").trim()
            val count = when (setId) {
                "subscriber", "bits" -> badgeInfo[setId]?.toIntOrNull() ?: versionId.toIntOrNull()
                else -> null
            }

            ChannelChatBadge(
                type = setId,
                text = humanizeBadgeLabel(setId),
                count = count,
                imageUrl = null,
            )
        }
    }

    private fun humanizeBadgeLabel(setId: String): String {
        return setId
            .split('_', '-')
            .filter(String::isNotBlank)
            .joinToString(" ") { part ->
                part.replaceFirstChar { character ->
                    if (character.isLowerCase()) {
                        character.titlecase(Locale.ROOT)
                    } else {
                        character.toString()
                    }
                }
            }
            .ifBlank { "Badge" }
    }

    private inner class TwitchIrcListener : WebSocket.Listener {
        @Volatile
        var connection: ConnectionState? = null

        private val pendingText = StringBuilder()

        override fun onOpen(webSocket: WebSocket): Unit {
            webSocket.request(1)
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            pendingText.append(data)
            if (last) {
                val payload = pendingText.toString()
                pendingText.setLength(0)
                handlePayload(payload)
            }

            webSocket.request(1)
            return CompletableFuture.completedFuture(null)
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*> {
            synchronized(connectionLock) {
                if (connectionState?.webSocket === webSocket) {
                    connectionState = null
                }
            }
            return CompletableFuture.completedFuture(null)
        }

        override fun onError(webSocket: WebSocket, error: Throwable) {
            synchronized(connectionLock) {
                if (connectionState?.webSocket === webSocket) {
                    connectionState = null
                }
            }
        }

        private fun handlePayload(payload: String) {
            val connection = connection ?: return
            payload.split("\r\n")
                .filter(String::isNotBlank)
                .forEach { line ->
                    when {
                        line.startsWith("PING ") -> sendCommand(connection, line.replaceFirst("PING", "PONG"))
                        " PRIVMSG " in line -> parsePrivmsg(line)?.let { parsed ->
                            pushMessage(parsed.channelSlug, parsed.message)
                        }
                    }
                }
        }
    }

    private data class ConnectionState(
        val accessToken: String,
        val login: String,
        val webSocket: WebSocket,
        val joinedChannels: MutableSet<String>,
    ) {
        fun close() {
            runCatching { webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "switching-session").join() }
        }
    }

    private data class ParsedPrivmsg(
        val channelSlug: String,
        val message: ChannelChatMessage,
    )
}