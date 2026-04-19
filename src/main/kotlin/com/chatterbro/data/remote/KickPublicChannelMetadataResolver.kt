package com.chatterbro.data.remote

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.io.IOException
import java.nio.file.Path
import java.util.Locale
import java.util.concurrent.TimeUnit

data class KickPublicChannelMetadata(
    val channelSlug: String,
    val displayName: String? = null,
    val isLive: Boolean? = null,
    val channelId: Long? = null,
    val chatroomId: Long? = null,
    val broadcasterUserId: Long? = null,
    val avatarUrl: String? = null,
    val channelUrl: String = "https://kick.com/$channelSlug",
)

class KickPublicChannelMetadataResolver(
    private val workingDirectory: Path,
) {
    private companion object {
        private const val CHANNEL_FETCH_TIMEOUT_SECONDS = 20L
        private val decoderJson = Json { ignoreUnknownKeys = true }
        private val nextFlightPushPattern = Regex("""push\(\[\d+,\"([\s\S]*?)\"\]\)""")
        private val htmlProfileImagePattern = Regex(
            """https://files\.kick\.com/images/user/\d+/profile_image/[^\"'\s<]+""",
            setOf(RegexOption.IGNORE_CASE),
        )
    }

    fun resolveMany(rawSlugs: Collection<String>): Map<String, KickPublicChannelMetadata> {
        return rawSlugs.asSequence()
            .map { it.trim().lowercase(Locale.ROOT) }
            .filter(String::isNotBlank)
            .distinct()
            .mapNotNull { slug ->
                runCatching { resolve(slug) }.getOrNull()?.let { metadata ->
                    slug to metadata
                }
            }
            .toMap()
    }

    fun resolve(rawChannelSlug: String): KickPublicChannelMetadata? {
        val normalizedChannelSlug = rawChannelSlug.trim().lowercase(Locale.ROOT)
        if (normalizedChannelSlug.isBlank()) {
            return null
        }

        val html = fetchChannelPageHtml(normalizedChannelSlug) ?: return null
        return parseChannelMetadata(html, normalizedChannelSlug)
    }

    internal fun parseChannelMetadata(html: String, rawChannelSlug: String): KickPublicChannelMetadata? {
        val normalizedChannelSlug = rawChannelSlug.trim().lowercase(Locale.ROOT)
        if (normalizedChannelSlug.isBlank() || html.isBlank()) {
            return null
        }

        val decodedHtml = decodeNextFlightData(html)
        val metadataSegment = selectMetadataSegment(decodedHtml, normalizedChannelSlug)
        val channelId = findFirstLong(
            metadataSegment,
            Regex("\"id\":(\\d+),\"slug\":\"${Regex.escape(normalizedChannelSlug)}\""),
        ) ?: findFirstLong(
            metadataSegment,
            Regex("\"slug\":\"${Regex.escape(normalizedChannelSlug)}\",\"id\":(\\d+)"),
        ) ?: findFirstLong(metadataSegment, Regex("\"channel_id\":(\\d+)"))
        val chatroomId = findFirstLong(metadataSegment, Regex("\"chatroom\":\\{\"id\":(\\d+)"))
            ?: findFirstLong(metadataSegment, Regex("\"chatroom_id\":(\\d+)"))

        if (channelId == null && chatroomId == null) {
            return null
        }

        val avatarUrl = findFirstGroup(metadataSegment, Regex("\"profile_pic\":\"([^\"]+)\""))
            ?: htmlProfileImagePattern.find(html)?.value
        val broadcasterUserId = findFirstLong(metadataSegment, Regex("\"broadcaster_user_id\":(\\d+)"))
            ?: findFirstLong(metadataSegment, Regex("\"user\":\\{\"id\":(\\d+)"))
            ?: avatarUrl?.let(::extractUserIdFromAvatarUrl)
        val displayName = decodeBasicHtmlEntities(
            findFirstGroup(html, Regex("<h1 id=\"channel-username\">([^<]+)</h1>", setOf(RegexOption.IGNORE_CASE)))
                ?: findFirstGroup(metadataSegment, Regex("\"username\":\"([^\"]+)\""))
                ?: normalizedChannelSlug,
        )
        val isLive = findFirstGroup(metadataSegment, Regex("\"is_live\":(true|false)"))
            ?.lowercase(Locale.ROOT)
            ?.let { value ->
                when (value) {
                    "true" -> true
                    "false" -> false
                    else -> null
                }
            }

        return KickPublicChannelMetadata(
            channelSlug = normalizedChannelSlug,
            displayName = displayName,
            isLive = isLive,
            channelId = channelId,
            chatroomId = chatroomId,
            broadcasterUserId = broadcasterUserId,
            avatarUrl = avatarUrl,
        )
    }

    private fun fetchChannelPageHtml(channelSlug: String): String? {
        val commandCandidates = if (System.getProperty("os.name").contains("Windows", ignoreCase = true)) {
            listOf("curl.exe", "curl")
        } else {
            listOf("curl")
        }

        for (command in commandCandidates) {
            val process = try {
                ProcessBuilder(
                    command,
                    "--max-time",
                    CHANNEL_FETCH_TIMEOUT_SECONDS.toString(),
                    "-L",
                    "-sS",
                    "--compressed",
                    "-H",
                    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
                    "-H",
                    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                    "-H",
                    "Accept-Language: cs-CZ,cs;q=0.9,en;q=0.8",
                    "https://kick.com/$channelSlug",
                )
                    .directory(workingDirectory.toFile())
                    .redirectErrorStream(true)
                    .start()
            } catch (_: IOException) {
                continue
            }

            val output = process.inputStream.readAllBytes().toString(Charsets.UTF_8)
            if (!process.waitFor(CHANNEL_FETCH_TIMEOUT_SECONDS + 2, TimeUnit.SECONDS)) {
                process.destroyForcibly()
                continue
            }

            if (process.exitValue() == 0 && output.isNotBlank()) {
                return output
            }
        }

        return null
    }

    private fun decodeNextFlightData(value: String): String {
        if (!value.contains("self.__next_f.push")) {
            return value
        }

        val decodedSegments = nextFlightPushPattern.findAll(value)
            .mapNotNull { matchResult ->
                val encodedSegment = matchResult.groupValues.getOrNull(1).orEmpty()
                if (encodedSegment.isBlank()) {
                    null
                } else {
                    runCatching {
                        decoderJson.decodeFromString<String>(buildString {
                            append('"')
                            append(encodedSegment)
                            append('"')
                        })
                    }.getOrNull()
                }
            }
            .filter(String::isNotBlank)
            .toList()

        return if (decodedSegments.isEmpty()) {
            value
        } else {
            decodedSegments.joinToString("\n")
        }
    }

    private fun selectMetadataSegment(decodedHtml: String, channelSlug: String): String {
        val slugPattern = Regex("\"slug\":\"${Regex.escape(channelSlug)}\"", setOf(RegexOption.IGNORE_CASE))
        var bestSegment = ""
        var bestScore = -1

        slugPattern.findAll(decodedHtml).forEach { matchResult ->
            val startIndex = (matchResult.range.first - 3_000).coerceAtLeast(0)
            val endIndex = (matchResult.range.first + 12_000).coerceAtMost(decodedHtml.length)
            val candidate = decodedHtml.substring(startIndex, endIndex)
            val score = (if (candidate.contains("\"chatroom\":{\"id\":")) 100 else 0)
                + (if (candidate.contains("\"channel_id\":")) 60 else 0)
                + (if (candidate.contains("\"broadcaster_user_id\":")) 20 else 0)
                + (if (candidate.contains("\"profile_pic\":")) 10 else 0)
                + (if (candidate.contains("\"is_live\":true")) 10 else 0)

            if (score > bestScore) {
                bestScore = score
                bestSegment = candidate
            }
        }

        return bestSegment.ifBlank { decodedHtml }
    }

    private fun findFirstLong(value: String, pattern: Regex): Long? {
        val matchValue = findFirstGroup(value, pattern) ?: return null
        return matchValue.toLongOrNull()
    }

    private fun findFirstGroup(value: String, pattern: Regex): String? {
        return pattern.find(value)
            ?.groupValues
            ?.getOrNull(1)
            ?.takeIf(String::isNotBlank)
    }

    private fun extractUserIdFromAvatarUrl(avatarUrl: String): Long? {
        return Regex("""/images/user/(\d+)/""", setOf(RegexOption.IGNORE_CASE))
            .find(avatarUrl)
            ?.groupValues
            ?.getOrNull(1)
            ?.toLongOrNull()
    }

    private fun decodeBasicHtmlEntities(value: String): String {
        return value
            .replace("&amp;", "&")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .trim()
    }
}