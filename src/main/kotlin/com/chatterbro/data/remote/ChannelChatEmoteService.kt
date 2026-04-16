package com.chatterbro.data.remote

import com.chatterbro.domain.model.ChannelChatEmote
import com.chatterbro.domain.model.ChannelChatEmoteCatalog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

class ChannelChatEmoteService(
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NORMAL)
        .build()

    @Volatile
    private var globalCache: CachedEmoteSnapshot? = null

    private val channelCache = ConcurrentHashMap<Long, CachedEmoteSnapshot>()
    private val cacheTtl = Duration.ofMinutes(30)

    suspend fun getChannelEmotes(channelSlug: String, channelUserId: Long?): ChannelChatEmoteCatalog {
        return withContext(Dispatchers.IO) {
            val globalEmotes = loadGlobalEmotes()
            val channelEmotes = channelUserId?.let { load7TvChannelEmotes(it) }.orEmpty()

            ChannelChatEmoteCatalog(
                channelSlug = channelSlug,
                channelUserId = channelUserId,
                emotes = mergeEmotes(globalEmotes, channelEmotes),
                updatedAt = Instant.now().toString(),
            )
        }
    }

    suspend fun getGlobalEmotes(): ChannelChatEmoteCatalog {
        return withContext(Dispatchers.IO) {
            ChannelChatEmoteCatalog(
                channelSlug = "global",
                channelUserId = null,
                emotes = loadGlobalEmotes(),
                updatedAt = Instant.now().toString(),
            )
        }
    }

    private fun loadGlobalEmotes(): List<ChannelChatEmote> {
        val now = Instant.now()
        val cached = globalCache
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.emotes
        }

        val mergedEmotes = mergeEmotes(
            runCatching { fetchBttvGlobalEmotes() }.getOrDefault(emptyList()),
            runCatching { fetch7TvGlobalEmotes() }.getOrDefault(emptyList()),
        )

        globalCache = CachedEmoteSnapshot(
            emotes = mergedEmotes,
            expiresAt = now.plus(cacheTtl),
        )

        return mergedEmotes
    }

    private fun load7TvChannelEmotes(channelUserId: Long): List<ChannelChatEmote> {
        val now = Instant.now()
        val cached = channelCache[channelUserId]
        if (cached != null && cached.expiresAt.isAfter(now)) {
            return cached.emotes
        }

        val emotes = runCatching { fetch7TvChannelEmotes(channelUserId) }.getOrDefault(emptyList())
        channelCache[channelUserId] = CachedEmoteSnapshot(
            emotes = emotes,
            expiresAt = now.plus(cacheTtl),
        )
        return emotes
    }

    private fun fetch7TvGlobalEmotes(): List<ChannelChatEmote> {
        val root = fetchJson("https://7tv.io/v3/emote-sets/global") as? JsonObject ?: return emptyList()
        val emotes = root.arrayValue("emotes") ?: return emptyList()
        return emotes.mapNotNull { parse7TvEmote(it) }
    }

    private fun fetch7TvChannelEmotes(channelUserId: Long): List<ChannelChatEmote> {
        val root = fetchJson("https://7tv.io/v3/users/KICK/$channelUserId") as? JsonObject ?: return emptyList()
        val emoteSet = root.objectValue("emote_set") ?: return emptyList()
        val emotes = emoteSet.arrayValue("emotes") ?: return emptyList()
        return emotes.mapNotNull { parse7TvEmote(it) }
    }

    private fun fetchBttvGlobalEmotes(): List<ChannelChatEmote> {
        val root = fetchJson("https://api.betterttv.net/3/cached/emotes/global") as? JsonArray ?: return emptyList()
        return root.mapNotNull { parseBttvEmote(it) }
    }

    private fun fetchJson(url: String): JsonElement? {
        val request = HttpRequest.newBuilder(URI.create(url))
            .GET()
            .timeout(Duration.ofSeconds(10))
            .header("Accept", "application/json")
            .header("User-Agent", "Chatterbro/0.1")
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            return null
        }

        return runCatching { json.parseToJsonElement(response.body()) }.getOrNull()
    }

    private fun parse7TvEmote(element: JsonElement): ChannelChatEmote? {
        val record = element as? JsonObject ?: return null
        val code = record.stringValue("name") ?: record.objectValue("data")?.stringValue("name") ?: return null
        val data = record.objectValue("data") ?: return null
        val host = data.objectValue("host") ?: return null
        val hostUrl = host.stringValue("url") ?: return null
        val selectedFile = select7TvFile(host.arrayValue("files") ?: return null) ?: return null
        val fileName = selectedFile.stringValue("name") ?: return null

        return ChannelChatEmote(
            code = code,
            imageUrl = buildImageUrl(hostUrl, fileName),
            provider = "7TV",
            animated = data.booleanValue("animated") ?: false,
            width = selectedFile.intValue("width"),
            height = selectedFile.intValue("height"),
        )
    }

    private fun parseBttvEmote(element: JsonElement): ChannelChatEmote? {
        val record = element as? JsonObject ?: return null
        if (record.booleanValue("modifier") == true) {
            return null
        }

        val code = record.stringValue("code") ?: return null
        val id = record.stringValue("id") ?: return null

        return ChannelChatEmote(
            code = code,
            imageUrl = "https://cdn.betterttv.net/emote/$id/2x",
            provider = "BTTV",
            animated = record.booleanValue("animated") ?: false,
            width = null,
            height = null,
        )
    }

    private fun select7TvFile(files: JsonArray): JsonObject? {
        val candidates = files.mapNotNull { it as? JsonObject }
        for (preferredFileName in preferred7TvFileNames) {
            val preferredMatch = candidates.firstOrNull { it.stringValue("name") == preferredFileName }
            if (preferredMatch != null) {
                return preferredMatch
            }
        }

        return candidates.firstOrNull()
    }

    private fun mergeEmotes(vararg emoteSets: List<ChannelChatEmote>): List<ChannelChatEmote> {
        val merged = LinkedHashMap<String, ChannelChatEmote>()
        for (emoteSet in emoteSets) {
            for (emote in emoteSet) {
                merged[emote.code] = emote
            }
        }
        return merged.values.toList()
    }

    private fun buildImageUrl(hostUrl: String, fileName: String): String {
        val normalizedHostUrl = hostUrl.removeSuffix("/")
        return when {
            normalizedHostUrl.startsWith("https://") || normalizedHostUrl.startsWith("http://") -> "$normalizedHostUrl/$fileName"
            normalizedHostUrl.startsWith("//") -> "https:$normalizedHostUrl/$fileName"
            else -> "https://$normalizedHostUrl/$fileName"
        }
    }

    private data class CachedEmoteSnapshot(
        val emotes: List<ChannelChatEmote>,
        val expiresAt: Instant,
    )

    private companion object {
        val preferred7TvFileNames = listOf(
            "2x.avif",
            "2x.webp",
            "2x.gif",
            "2x.png",
            "3x.avif",
            "3x.webp",
            "3x.gif",
            "3x.png",
            "1x.avif",
            "1x.webp",
            "1x.gif",
            "1x.png",
        )
    }
}

private fun JsonObject.stringValue(name: String): String? {
    return this[name]?.jsonPrimitive?.contentOrNull
}

private fun JsonObject.intValue(name: String): Int? {
    return this[name]?.jsonPrimitive?.intOrNull
}

private fun JsonObject.booleanValue(name: String): Boolean? {
    return this[name]?.jsonPrimitive?.booleanOrNull
}

private fun JsonObject.objectValue(name: String): JsonObject? {
    return this[name] as? JsonObject
}

private fun JsonObject.arrayValue(name: String): JsonArray? {
    return this[name] as? JsonArray
}