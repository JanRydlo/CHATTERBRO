package com.chatterbro.domain.repository

import com.chatterbro.domain.model.FollowedChannel

interface KickRepository {
    suspend fun getLiveFollowedChannels(): List<FollowedChannel>
}
