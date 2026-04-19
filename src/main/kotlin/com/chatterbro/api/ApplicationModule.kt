package com.chatterbro.api

import com.chatterbro.api.dto.ErrorResponse
import com.chatterbro.api.dto.SendChannelChatMessageRequest
import com.chatterbro.data.bridge.KickBridgePaths
import com.chatterbro.data.bridge.KickBridgeRunner
import com.chatterbro.data.bridge.KickBridgeStatusStore
import com.chatterbro.data.oauth.KickOAuthConfig
import com.chatterbro.data.oauth.KickOAuthService
import com.chatterbro.data.remote.ChannelChatEmoteService
import com.chatterbro.data.remote.KickPublicChannelMetadataResolver
import com.chatterbro.data.remote.PlaywrightKickBridgeDataSource
import com.chatterbro.data.repository.BridgeBackedKickRepository
import com.chatterbro.domain.model.ChannelChat
import com.chatterbro.domain.model.ChannelChatRequest
import com.chatterbro.domain.model.FollowedChannel
import com.chatterbro.domain.usecase.LoadChannelChatUseCase
import com.chatterbro.domain.usecase.LoadLiveFollowedChannelsUseCase
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.http.content.staticFiles
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.request.receive
import io.ktor.server.response.respondRedirect
import io.ktor.server.request.path
import io.ktor.server.response.respond
import io.ktor.server.response.respondFile
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.nio.file.Paths
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.readText

private val bridgeCacheJson = Json {
    ignoreUnknownKeys = true
}

fun Application.chatterbroModule() {
    val rootDirectory = Paths.get("").toAbsolutePath().normalize()
    val bridgePaths = KickBridgePaths(rootDirectory)
    val oauthConfig = KickOAuthConfig.fromEnvironment()
    val bridgeStatusStore = KickBridgeStatusStore(bridgePaths, oauthEnabled = oauthConfig != null)
    val oauthService = oauthConfig?.let { KickOAuthService(it, bridgePaths, bridgeStatusStore) }
    val bridgeRunner = KickBridgeRunner(bridgePaths, bridgeStatusStore)
    val remoteDataSource = PlaywrightKickBridgeDataSource(bridgeRunner, bridgeStatusStore, oauthService)
    val repository = BridgeBackedKickRepository(remoteDataSource)
    val loadLiveFollowedChannels = LoadLiveFollowedChannelsUseCase(repository)
    val loadChannelChat = LoadChannelChatUseCase(repository)
    val publicChannelMetadataResolver = KickPublicChannelMetadataResolver(rootDirectory)
    val channelChatEmoteService = ChannelChatEmoteService()
    val frontendDistDirectory = rootDirectory.resolve("frontend").resolve("dist").toFile()
    val frontendAssetsDirectory = frontendDistDirectory.resolve("assets")
    val frontendIndexFile = frontendDistDirectory.resolve("index.html")

    install(CallLogging)
    install(CORS) {
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
        allowMethod(HttpMethod.Options)
        allowHeader("Content-Type")
        anyHost()
    }
    install(ContentNegotiation) {
        json(
            Json {
                encodeDefaults = true
                prettyPrint = true
                ignoreUnknownKeys = true
            },
        )
    }

    routing {
        route("/api") {
            get("/health") {
                call.respond(mapOf("status" to "ok"))
            }

            get("/chat/emotes/global") {
                call.respond(channelChatEmoteService.getGlobalEmotes())
            }

            get("/bridge/status") {
                call.respond(remoteDataSource.getBridgeStatus())
            }

            post("/bridge/start") {
                try {
                    val forceReconnect = call.request.queryParameters["forceReconnect"]
                        ?.toBooleanStrictOrNull() == true
                    call.respond(remoteDataSource.startBridgeSession(forceReconnect = forceReconnect))
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick browser bridge could not be started."
                    val statusCode = if (
                        message.contains("OAuth-only mode", ignoreCase = true) ||
                        message.contains("Kick Public API", ignoreCase = true)
                    ) {
                        HttpStatusCode.NotImplemented
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(
                        statusCode,
                        ErrorResponse(message),
                    )
                }
            }

            get("/auth/login") {
                val service = oauthService
                if (service == null) {
                    call.respondRedirect("/?auth=error&message=Kick%20OAuth%20is%20not%20configured.")
                    return@get
                }

                call.respondRedirect(service.beginAuthorization())
            }

            get("/auth/callback") {
                val service = oauthService
                if (service == null) {
                    call.respondRedirect("/?auth=error&message=Kick%20OAuth%20is%20not%20configured.")
                    return@get
                }

                val error = call.parameters["error"]?.trim()
                if (!error.isNullOrBlank()) {
                    val description = call.parameters["error_description"]?.trim().orEmpty().ifBlank { error }
                    call.respondRedirect(service.buildFrontendRedirect(success = false, message = description))
                    return@get
                }

                val code = call.parameters["code"]?.trim().orEmpty()
                val state = call.parameters["state"]?.trim().orEmpty()
                if (code.isBlank() || state.isBlank()) {
                    call.respondRedirect(service.buildFrontendRedirect(success = false, message = "Kick OAuth callback is missing code or state."))
                    return@get
                }

                try {
                    service.handleCallback(code, state)
                    call.respondRedirect(service.buildFrontendRedirect(success = true, message = "Kick OAuth connected successfully."))
                } catch (exception: IllegalStateException) {
                    call.respondRedirect(service.buildFrontendRedirect(success = false, message = exception.message ?: "Kick OAuth callback failed."))
                }
            }

            get("/following/live") {
                try {
                    call.respond(
                        enrichLiveFollowedChannels(
                            followedChannels = loadLiveFollowedChannels(),
                            oauthService = oauthService,
                            bridgePaths = bridgePaths,
                            publicChannelMetadataResolver = publicChannelMetadataResolver,
                        ),
                    )
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick bridge failed to load channels."
                    val statusCode = if (
                        message.contains("OAuth-only mode", ignoreCase = true) ||
                        message.contains("Kick Public API", ignoreCase = true)
                    ) {
                        HttpStatusCode.NotImplemented
                    } else if (
                        message.contains("sign in", ignoreCase = true) ||
                        message.contains("expired", ignoreCase = true) ||
                        message.contains("missing", ignoreCase = true)
                    ) {
                        HttpStatusCode.Unauthorized
                    } else if (
                        message.contains("Reconnect Kick browser", ignoreCase = true) ||
                        message.contains("browser sync is not running", ignoreCase = true)
                    ) {
                        HttpStatusCode.Conflict
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(
                        statusCode,
                        ErrorResponse(message),
                    )
                }
            }

            get("/channels/live") {
                val service = oauthService
                if (service == null) {
                    call.respond(HttpStatusCode.NotImplemented, ErrorResponse("Kick OAuth is not configured."))
                    return@get
                }

                val slugs = call.request.queryParameters
                    .getAll("slug")
                    .orEmpty()
                    .flatMap { value ->
                        value.split(',')
                    }
                    .map(String::trim)
                    .filter(String::isNotBlank)
                    .distinct()

                if (slugs.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Add at least one channel slug."))
                    return@get
                }

                try {
                    call.respond(
                        enrichChannelsWithPublicMetadata(
                            service.fetchTrackedChannelsBySlugs(slugs),
                            publicChannelMetadataResolver,
                        ).filter(FollowedChannel::isLive),
                    )
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick OAuth failed to load tracked live channels."
                    val statusCode = if (
                        message.contains("sign in", ignoreCase = true) ||
                        message.contains("expired", ignoreCase = true) ||
                        message.contains("token", ignoreCase = true)
                    ) {
                        HttpStatusCode.Unauthorized
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(statusCode, ErrorResponse(message))
                }
            }

            get("/channels/tracked") {
                val service = oauthService
                if (service == null) {
                    call.respond(HttpStatusCode.NotImplemented, ErrorResponse("Kick OAuth is not configured."))
                    return@get
                }

                val slugs = call.request.queryParameters
                    .getAll("slug")
                    .orEmpty()
                    .flatMap { value ->
                        value.split(',')
                    }
                    .map(String::trim)
                    .filter(String::isNotBlank)
                    .distinct()

                if (slugs.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Add at least one channel slug."))
                    return@get
                }

                try {
                    call.respond(
                        enrichChannelsWithPublicMetadata(
                            service.fetchTrackedChannelsBySlugs(slugs),
                            publicChannelMetadataResolver,
                        ),
                    )
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick OAuth failed to load tracked channels."
                    val statusCode = if (
                        message.contains("sign in", ignoreCase = true) ||
                        message.contains("expired", ignoreCase = true) ||
                        message.contains("token", ignoreCase = true)
                    ) {
                        HttpStatusCode.Unauthorized
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(statusCode, ErrorResponse(message))
                }
            }

            get("/chat/{channelSlug}/emotes") {
                val channelSlug = call.parameters["channelSlug"]?.trim().orEmpty()
                if (channelSlug.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel slug is required."))
                    return@get
                }

                val rawChannelUserId = call.request.queryParameters["channelUserId"]?.trim()
                val channelUserId = rawChannelUserId
                    ?.takeIf { it.isNotBlank() }
                    ?.toLongOrNull()

                if (!rawChannelUserId.isNullOrBlank() && channelUserId == null) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel user id must be a number."))
                    return@get
                }

                call.respond(channelChatEmoteService.getChannelEmotes(channelSlug, channelUserId))
            }

            get("/chat/{channelSlug}") {
                val channelSlug = call.parameters["channelSlug"]?.trim().orEmpty()
                if (channelSlug.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel slug is required."))
                    return@get
                }

                val rawChannelId = call.request.queryParameters["channelId"]?.trim()
                val channelId = rawChannelId
                    ?.takeIf { it.isNotBlank() }
                    ?.toLongOrNull()

                if (!rawChannelId.isNullOrBlank() && channelId == null) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel id must be a number."))
                    return@get
                }

                val rawChannelUserId = call.request.queryParameters["channelUserId"]?.trim()
                val channelUserId = rawChannelUserId
                    ?.takeIf { it.isNotBlank() }
                    ?.toLongOrNull()

                if (!rawChannelUserId.isNullOrBlank() && channelUserId == null) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel user id must be a number."))
                    return@get
                }

                val chatRequest = ChannelChatRequest(
                    channelSlug = channelSlug,
                    channelId = channelId,
                    channelUserId = channelUserId,
                    displayName = call.request.queryParameters["displayName"]?.trim()?.takeIf(String::isNotBlank),
                    avatarUrl = call.request.queryParameters["avatarUrl"]?.trim()?.takeIf(String::isNotBlank),
                    fast = call.request.queryParameters["fast"]?.trim()?.equals("true", ignoreCase = true) == true,
                )

                try {
                    call.respond(loadChannelChat(chatRequest))
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick bridge failed to load channel chat."
                    val statusCode = if (
                        message.contains("OAuth-only mode", ignoreCase = true) ||
                        message.contains("Kick Public API", ignoreCase = true)
                    ) {
                        HttpStatusCode.NotImplemented
                    } else if (
                        message.contains("sign in", ignoreCase = true) ||
                        message.contains("expired", ignoreCase = true) ||
                        message.contains("missing", ignoreCase = true)
                    ) {
                        HttpStatusCode.Unauthorized
                    } else if (
                        message.contains("Reconnect Kick browser", ignoreCase = true) ||
                        message.contains("browser sync is not running", ignoreCase = true)
                    ) {
                        HttpStatusCode.Conflict
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(
                        statusCode,
                        ErrorResponse(message),
                    )
                }
            }

            post("/chat/{channelSlug}/messages") {
                val service = oauthService
                if (service == null) {
                    call.respond(HttpStatusCode.NotImplemented, ErrorResponse("Kick OAuth is not configured."))
                    return@post
                }

                val channelSlug = call.parameters["channelSlug"]?.trim().orEmpty()
                if (channelSlug.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel slug is required."))
                    return@post
                }

                val request = try {
                    call.receive<SendChannelChatMessageRequest>()
                } catch (_: Exception) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Chat message request body is invalid."))
                    return@post
                }

                try {
                    call.respond(
                        service.sendChatMessage(
                            channelSlug = channelSlug,
                            broadcasterUserId = request.broadcasterUserId,
                            content = request.content,
                            replyToMessageId = request.replyToMessageId,
                        ),
                    )
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick failed to send the chat message."
                    val statusCode = when {
                        message.contains("chat:write", ignoreCase = true) -> HttpStatusCode.Forbidden
                        message.contains("sign in", ignoreCase = true) ||
                            message.contains("expired", ignoreCase = true) ||
                            message.contains("token", ignoreCase = true) -> HttpStatusCode.Unauthorized
                        message.contains("Enter a chat message", ignoreCase = true) ||
                            message.contains("broadcaster user id", ignoreCase = true) -> HttpStatusCode.BadRequest
                        else -> HttpStatusCode.BadGateway
                    }

                    call.respond(statusCode, ErrorResponse(message))
                }
            }
        }

        if (frontendDistDirectory.exists()) {
            if (frontendAssetsDirectory.exists()) {
                staticFiles("/assets", frontendAssetsDirectory)
            }

            get("/") {
                call.respondFile(frontendIndexFile)
            }

            get("/{...}") {
                val requestedPath = call.request.path()
                val lastPathSegment = requestedPath.substringAfterLast('/')

                if (requestedPath.startsWith("/api/") || requestedPath.startsWith("/assets/") || lastPathSegment.contains('.')) {
                    call.respond(HttpStatusCode.NotFound, ErrorResponse("Unknown API route."))
                    return@get
                }

                call.respondFile(frontendIndexFile)
            }
        }
    }
}

private fun enrichLiveFollowedChannels(
    followedChannels: List<FollowedChannel>,
    oauthService: KickOAuthService?,
    bridgePaths: KickBridgePaths,
    publicChannelMetadataResolver: KickPublicChannelMetadataResolver,
): List<FollowedChannel> {
    if (followedChannels.isEmpty()) {
        return followedChannels
    }

    val cachedChannelsBySlug = readCachedFollowedChannels(bridgePaths)
    val enrichedChannelsBySlug = if (oauthService == null) {
        emptyMap()
    } else {
        try {
            oauthService.fetchTrackedChannelsBySlugs(
                followedChannels.map(FollowedChannel::channelSlug),
            ).associateBy { channel ->
                channel.channelSlug.trim().lowercase()
            }
        } catch (_: IllegalStateException) {
            emptyMap()
        }
    }

    val mergedChannels = followedChannels.map { channel ->
        val normalizedSlug = channel.channelSlug.trim().lowercase()
        val cachedChannel = cachedChannelsBySlug[normalizedSlug]
        val oauthChannel = enrichedChannelsBySlug[normalizedSlug]

        val cachedMergedChannel = if (cachedChannel == null) {
            channel
        } else {
            mergeFollowedChannel(channel, cachedChannel)
        }

        if (oauthChannel == null) {
            cachedMergedChannel
        } else {
            mergeFollowedChannel(cachedMergedChannel, oauthChannel)
        }
    }

    return enrichChannelsWithPublicMetadata(mergedChannels, publicChannelMetadataResolver)
}

private fun enrichChannelsWithPublicMetadata(
    channels: List<FollowedChannel>,
    publicChannelMetadataResolver: KickPublicChannelMetadataResolver,
): List<FollowedChannel> {
    if (channels.isEmpty()) {
        return channels
    }

    val missingMetadataSlugs = channels.filter { channel ->
        channel.chatroomId == null || channel.channelId == null || !channel.isLive
    }.map(FollowedChannel::channelSlug)

    if (missingMetadataSlugs.isEmpty()) {
        return channels
    }

    val metadataBySlug = publicChannelMetadataResolver.resolveMany(missingMetadataSlugs)
    if (metadataBySlug.isEmpty()) {
        return channels
    }

    return channels.map { channel ->
        val metadata = metadataBySlug[channel.channelSlug.trim().lowercase()] ?: return@map channel
        FollowedChannel(
            channelSlug = channel.channelSlug,
            displayName = if (channel.displayName.equals(channel.channelSlug, ignoreCase = true)) {
                metadata.displayName ?: channel.displayName
            } else {
                channel.displayName.ifBlank { metadata.displayName ?: channel.channelSlug }
            },
            isLive = channel.isLive || metadata.isLive == true,
            channelUrl = channel.channelUrl.ifBlank { metadata.channelUrl },
            chatUrl = channel.chatUrl ?: metadata.channelUrl,
            thumbnailUrl = channel.thumbnailUrl ?: metadata.avatarUrl,
            broadcasterUserId = channel.broadcasterUserId ?: metadata.broadcasterUserId,
            channelId = channel.channelId ?: metadata.channelId,
            chatroomId = channel.chatroomId ?: metadata.chatroomId,
            viewerCount = channel.viewerCount,
            streamTitle = channel.streamTitle,
            categoryName = channel.categoryName,
            tags = channel.tags,
        )
    }
}

private fun readCachedFollowedChannels(bridgePaths: KickBridgePaths): Map<String, FollowedChannel> {
    val cacheFiles = buildList {
        if (bridgePaths.chatOutputFile.exists()) {
            add(bridgePaths.chatOutputFile)
        }
        if (bridgePaths.chatCacheDirectory.exists()) {
            addAll(bridgePaths.chatCacheDirectory.listDirectoryEntries("*.json"))
        }
    }

    if (cacheFiles.isEmpty()) {
        return emptyMap()
    }

    return cacheFiles.mapNotNull(::readCachedFollowedChannel)
        .associateBy(FollowedChannel::channelSlug)
}

private fun readCachedFollowedChannel(path: java.nio.file.Path): FollowedChannel? {
    return try {
        val chat = bridgeCacheJson.decodeFromString<ChannelChat>(path.readText())
        val normalizedSlug = chat.channelSlug.trim().lowercase()
        if (normalizedSlug.isBlank()) {
            null
        } else {
            FollowedChannel(
                channelSlug = normalizedSlug,
                displayName = chat.displayName,
                isLive = true,
                channelUrl = chat.channelUrl,
                chatUrl = chat.channelUrl,
                thumbnailUrl = chat.avatarUrl,
                broadcasterUserId = chat.channelUserId,
                channelId = chat.channelId,
                chatroomId = chat.chatroomId,
            )
        }
    } catch (_: Exception) {
        null
    }
}

private fun mergeFollowedChannel(
    baseChannel: FollowedChannel,
    enrichedChannel: FollowedChannel,
): FollowedChannel {
    return FollowedChannel(
        channelSlug = baseChannel.channelSlug.ifBlank { enrichedChannel.channelSlug },
        displayName = baseChannel.displayName.ifBlank { enrichedChannel.displayName },
        isLive = baseChannel.isLive || enrichedChannel.isLive,
        channelUrl = baseChannel.channelUrl.ifBlank { enrichedChannel.channelUrl },
        chatUrl = baseChannel.chatUrl ?: enrichedChannel.chatUrl,
        thumbnailUrl = baseChannel.thumbnailUrl ?: enrichedChannel.thumbnailUrl,
        broadcasterUserId = baseChannel.broadcasterUserId ?: enrichedChannel.broadcasterUserId,
        channelId = baseChannel.channelId ?: enrichedChannel.channelId,
        chatroomId = baseChannel.chatroomId ?: enrichedChannel.chatroomId,
        viewerCount = baseChannel.viewerCount ?: enrichedChannel.viewerCount,
        streamTitle = baseChannel.streamTitle ?: enrichedChannel.streamTitle,
        categoryName = baseChannel.categoryName ?: enrichedChannel.categoryName,
        tags = if (baseChannel.tags.isNotEmpty()) baseChannel.tags else enrichedChannel.tags,
    )
}
