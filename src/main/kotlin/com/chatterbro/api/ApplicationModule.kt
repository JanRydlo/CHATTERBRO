package com.chatterbro.api

import com.chatterbro.api.dto.ErrorResponse
import com.chatterbro.data.bridge.KickBridgePaths
import com.chatterbro.data.bridge.KickBridgeRunner
import com.chatterbro.data.bridge.KickBridgeStatusStore
import com.chatterbro.data.oauth.KickOAuthConfig
import com.chatterbro.data.oauth.KickOAuthService
import com.chatterbro.data.remote.PlaywrightKickBridgeDataSource
import com.chatterbro.data.repository.BridgeBackedKickRepository
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
import io.ktor.server.response.respondRedirect
import io.ktor.server.request.path
import io.ktor.server.response.respond
import io.ktor.server.response.respondFile
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.serialization.json.Json
import java.nio.file.Paths

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

            get("/bridge/status") {
                call.respond(remoteDataSource.getBridgeStatus())
            }

            post("/bridge/start") {
                call.respond(remoteDataSource.startBridgeSession())
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
                    call.respond(loadLiveFollowedChannels())
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick bridge failed to load channels."
                    val statusCode = if (
                        message.contains("sign in", ignoreCase = true) ||
                        message.contains("expired", ignoreCase = true) ||
                        message.contains("missing", ignoreCase = true)
                    ) {
                        HttpStatusCode.Unauthorized
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(
                        statusCode,
                        ErrorResponse(message),
                    )
                }
            }

            get("/chat/{channelSlug}") {
                val channelSlug = call.parameters["channelSlug"]?.trim().orEmpty()
                if (channelSlug.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ErrorResponse("Channel slug is required."))
                    return@get
                }

                try {
                    call.respond(loadChannelChat(channelSlug))
                } catch (exception: IllegalStateException) {
                    val message = exception.message ?: "Kick bridge failed to load channel chat."
                    val statusCode = if (
                        message.contains("sign in", ignoreCase = true) ||
                        message.contains("expired", ignoreCase = true) ||
                        message.contains("missing", ignoreCase = true)
                    ) {
                        HttpStatusCode.Unauthorized
                    } else {
                        HttpStatusCode.BadGateway
                    }

                    call.respond(
                        statusCode,
                        ErrorResponse(message),
                    )
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
