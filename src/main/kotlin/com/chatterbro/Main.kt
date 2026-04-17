package com.chatterbro

import com.chatterbro.api.chatterbroModule
import com.chatterbro.config.LocalEnvironment
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty

fun main() {
    val port = LocalEnvironment.read("CHATTERBRO_PORT")?.toIntOrNull() ?: 8080

    embeddedServer(
        factory = Netty,
        host = "0.0.0.0",
        port = port,
        module = { chatterbroModule() },
    ).start(wait = true)
}
