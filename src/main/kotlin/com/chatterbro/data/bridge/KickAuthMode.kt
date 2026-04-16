package com.chatterbro.data.bridge

import kotlinx.serialization.Serializable

@Serializable
enum class KickAuthMode {
    NONE,
    OAUTH,
    BROWSER_SESSION,
}