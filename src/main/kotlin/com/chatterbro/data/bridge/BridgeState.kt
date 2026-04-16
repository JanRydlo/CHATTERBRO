package com.chatterbro.data.bridge

import kotlinx.serialization.Serializable

@Serializable
enum class BridgeState {
    IDLE,
    RUNNING,
    READY,
    ERROR,
}
